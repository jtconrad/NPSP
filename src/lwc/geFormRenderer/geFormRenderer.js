import { LightningElement, api, track, wire } from 'lwc';
import GeFormService from 'c/geFormService';
import { NavigationMixin } from 'lightning/navigation';
import messageLoading from '@salesforce/label/c.labelMessageLoading';
import geSave from '@salesforce/label/c.labelGeSave';
import geCancel from '@salesforce/label/c.labelGeCancel';
import geUpdate from '@salesforce/label/c.labelGeUpdate';
import { showToast, handleError, getRecordFieldNames, setRecordValuesOnTemplate } from 'c/utilTemplateBuilder';
import { getQueryParameters, isNotEmpty } from 'c/utilCommon';
import { getRecord } from 'lightning/uiRecordApi';
import FORM_TEMPLATE_FIELD from '@salesforce/schema/DataImportBatch__c.Form_Template__c';
import TEMPLATE_JSON_FIELD from '@salesforce/schema/Form_Template__c.Template_JSON__c';
import STATUS_FIELD from '@salesforce/schema/DataImport__c.Status__c';
import NPSP_DATA_IMPORT_BATCH_FIELD
    from '@salesforce/schema/DataImport__c.NPSP_Data_Import_Batch__c';

const mode = {
    CREATE: 'create',
    UPDATE: 'update'
}

export default class GeFormRenderer extends NavigationMixin(LightningElement) {
    @api donorRecordId = '';
    @api donorRecord;
    fieldNames = [];
    @track formTemplate;
    @track fieldMappings;
    @api sections = [];
    @track ready = false;
    @track name = '';
    @track description = '';
    @track mappingSet = '';
    @track version = '';
    @api showSpinner = false;
    @api batchId;
    @api hasPageLevelError = false;
    label = { messageLoading, geSave, geCancel };
    @track formTemplateId;
    erroredFields = [];
    @api pageLevelErrorMessageList = [];
    @track _dataRow; // Row being updated when in update mode

    @wire(getRecord, { recordId: '$donorRecordId', optionalFields: '$fieldNames'})
    wiredGetRecordMethod({ error, data }) {
        if (data) {
            this.donorRecord = data;
            this.initializeForm(this.formTemplate, this.fieldMappings);
        } else if (error) {
            console.error(JSON.stringify(error));
        }
    }

    connectedCallback() {
        if (this.batchId) {
            // When the form is being used for Batch Gift Entry, the Form Template JSON
            // uses the @wire service below to retrieve the Template using the Template Id
            // stored on the Batch.
            return;
        }

        // check if there is a record id in the url
        this.donorRecordId = getQueryParameters().c__recordId;

        GeFormService.getFormTemplate().then(response => {
            // read the template header info
            if(response !== null && typeof response !== 'undefined') {
                this.formTemplate  = response.formTemplate;
                this.fieldMappings = response.fieldMappingSetWrapper.fieldMappingByDevName;

                // get the target field names to be used by getRecord
                this.fieldNames = getRecordFieldNames(this.formTemplate, this.fieldMappings);
            }
        });
    }

    initializeForm(formTemplate, fieldMappings) {
        // read the template header info
        this.ready = true;
        this.name = formTemplate.name;
        this.description = formTemplate.description;
        this.version = formTemplate.layout.version;
        if (typeof formTemplate.layout !== 'undefined'
            && Array.isArray(formTemplate.layout.sections)) {

            // add record data to the template fields
            if (isNotEmpty(fieldMappings) && isNotEmpty(this.donorRecord)) {
                let sectionsWithValues = setRecordValuesOnTemplate(formTemplate.layout.sections, fieldMappings, this.donorRecord);
                this.sections = sectionsWithValues;
            } else {
                this.sections = formTemplate.layout.sections;
            }
            this.dispatchEvent(new CustomEvent('sectionsretrieved'));
        }
    }

    @wire(getRecord, {
        recordId: '$batchId',
        fields: FORM_TEMPLATE_FIELD
    })
    wiredBatch({data, error}) {
        if (data) {
            this.formTemplateId = data.fields[FORM_TEMPLATE_FIELD.fieldApiName].value;
        } else if (error) {
            handleError(error);
        }
    }

    @wire(getRecord, {
        recordId: '$formTemplateId',
        fields: TEMPLATE_JSON_FIELD
    })
    wiredTemplate({data, error}) {
        if (data) {
            this.loadTemplate(
                JSON.parse(data.fields[TEMPLATE_JSON_FIELD.fieldApiName].value));
        } else if (error) {
            handleError(error);
        }
    }

    async loadTemplate(formTemplate){
        // With the change to using a Lookup field to connect a Batch to a Template,
        // we can use getRecord to get the Template JSON.  But the GeFormService
        // component still needs to be initialized with the field mappings, and the
        // call to getFormTemplate() does that.
        // TODO: Maybe initialize GeFormService with the field mappings in its connected
        //       callback instead?
        await GeFormService.getFormTemplate();
        this.initializeForm(formTemplate);
    }

    handleCancel() {
        this.reset();
    }

    handleSave(event) {
        this.clearErrors();

        const sectionsList = this.template.querySelectorAll('c-ge-form-section');

        if(!this.isFormValid(sectionsList)){
            return;
        }

        // disable the Save button
        event.target.disabled = true;
        const enableSaveButton = function() {
            this.disabled = false;
        }.bind(event.target);

        // show the spinner
        this.toggleSpinner();

        // callback used to toggle spinner after save
        const toggleSpinner = () => this.toggleSpinner();

        const reset = () => this.reset();

        if (this.batchId) {
            const data = this.getData(sectionsList);

            this.dispatchEvent(new CustomEvent('submit', {
                detail: {
                    data: data,
                    success: function () {
                        enableSaveButton();
                        toggleSpinner();
                        reset();
                    },
                    error: function() {
                        enableSaveButton();
                        toggleSpinner();
                    }
                }
            }));
        } else {
            GeFormService.handleSave(sectionsList, this.donorRecord).then(opportunityId => {
                this.navigateToRecordPage(opportunityId);
            })
                .catch(error => {

                    this.toggleSpinner();

                    // Show on top if it is a page level
                    this.hasPageLevelError = true;
                    const exceptionWrapper = JSON.parse(error.body.message);
                    const allDisplayedFields = this.getDisplayedFieldsMappedByAPIName(sectionsList);

                    if (exceptionWrapper.exceptionType !== null && exceptionWrapper.exceptionType !== '') {

                        // Check to see if there are any field level errors
                        if (Object.entries(exceptionWrapper.DMLErrorFieldNameMapping).length === undefined || Object.entries(exceptionWrapper.DMLErrorFieldNameMapping).length === 0) {

                            // If there are no specific fields the error has to go to, put it on the page level error message.
                            for (const dmlIndex in exceptionWrapper.DMLErrorMessageMapping) {
                                this.pageLevelErrorMessageList = [...this.pageLevelErrorMessageList, {index: dmlIndex, errorMessage: exceptionWrapper.DMLErrorMessageMapping[dmlIndex]}];
                            }
                        } else {
                            // If there is a specific field that each error is supposed to go to, show it on the field on the page.
                            // If it is not on the page to show, display it on the page level.
                            for (const key in exceptionWrapper.DMLErrorFieldNameMapping) {

                                // List of fields with this error
                                let fieldList = exceptionWrapper.DMLErrorFieldNameMapping[key];

                                // Error message for the field.
                                let errorMessage = exceptionWrapper.DMLErrorMessageMapping[key];

                                // Errored fields that are not displayed
                                let hiddenFieldList = [];

                                fieldList.forEach(fieldWithError => {
                                    // Go to the field and set the error message using setCustomValidity
                                    if (fieldWithError in allDisplayedFields) {
                                        let fieldInput = allDisplayedFields[fieldWithError];
                                        this.erroredFields.push(fieldInput);

                                        fieldInput.setCustomValidity(errorMessage);
                                    } else {

                                        // Keep track of errored fields that are not displayed.
                                        hiddenFieldList.push(fieldWithError);
                                    }
                                });

                                // If there are hidden fields, display the error message at the page level.
                                // With the fields noted.
                                if (hiddenFieldList.length > 0) {
                                    let combinedFields = hiddenFieldList.join(', ');

                                    this.pageLevelErrorMessageList = [...this.pageLevelErrorMessageList, {index: key, errorMessage: errorMessage + ' [' + combinedFields + ']'}];
                                }
                            }
                        }
                    } else {
                        pageLevelErrorMessageList = [...pageLevelErrorMessageList, {index: 0, errorMessage: exceptionWrapper.errorMessage}];
                    }

                    // focus either the page level or field level error messsage somehow
                    window.scrollTo(0,0);
                }) ;
        }
    }

    isFormValid(sectionsList){
        let invalidFields = [];
        sectionsList.forEach(section => {
            const fields = section.getInvalidFields();
            invalidFields.push(...fields);
        });

        if(invalidFields.length > 0){
            let fieldListAsString = invalidFields.join(', ');
            showToast('Invalid Form', 'The following fields are required: ' + fieldListAsString, 'error');
        }

        return invalidFields.length === 0;
    }

    navigateToRecordPage(recordId) {
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: {
                recordId: recordId,
                actionName: 'view'
            }
        });
    }

    // change showSpinner to the opposite of its current value
    toggleSpinner() {
        this.showSpinner = !this.showSpinner;
    }

    getDisplayedFieldsMappedByAPIName(sectionsList) {
        let allFields = {};
        sectionsList.forEach(section => {
            const fields = section.getAllFieldsByAPIName();

            allFields = Object.assign(allFields, fields);
        });

        return allFields;
    }

    clearErrors() {

        // Clear the page level error
        this.pageLevelErrorMessageList = [];

        // Clear the field level errors
        if (this.erroredFields.length > 0) {
            this.erroredFields.forEach(fieldToReset => {
                fieldToReset.setCustomValidity('');
            });
        }

        this.erroredFields = [];
    }

    @api
    load(dataRow) {
        this._dataRow = dataRow;
        const sectionsList = this.template.querySelectorAll('c-ge-form-section');

        sectionsList.forEach(section => {
            section.load(dataRow);
        });
    }

    @api
    reset() {
        this._dataRow = undefined;
        const sectionsList = this.template.querySelectorAll('c-ge-form-section');

        sectionsList.forEach(section => {
            section.reset();
        });
    }

    get mode() {
        return this._dataRow ? mode.UPDATE : mode.CREATE;
    }

    @api
    get saveActionLabel() {
        switch (this.mode) {
            case mode.UPDATE:
                return geUpdate;
                break;
            default:
                return geSave;
        }
    }

    @api
    get isUpdateActionDisabled() {
        return this._dataRow && this._dataRow[STATUS_FIELD.fieldApiName] === 'Imported';
    }

    getData(sections) {
        let dataImportRecord =
            GeFormService.getDataImportRecord(sections);

        if (!dataImportRecord[NPSP_DATA_IMPORT_BATCH_FIELD.fieldApiName]) {
            dataImportRecord[NPSP_DATA_IMPORT_BATCH_FIELD.fieldApiName] = this.batchId;
        }

        if (this._dataRow) {
            dataImportRecord.Id = this._dataRow.Id;
        }

        return dataImportRecord;
    }

}