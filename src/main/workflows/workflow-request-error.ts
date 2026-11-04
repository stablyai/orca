import type { WorkflowValidationIssue } from '../../shared/workflow/workflow-validation-types'

/** A refusal the workflow RPCs surface to the user with a stable code. */
export class WorkflowRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WorkflowRequestError'
  }
}

/** A launch refused by validation; carries the issues so the editor can point at each node. */
export class WorkflowValidationError extends WorkflowRequestError {
  constructor(readonly issues: WorkflowValidationIssue[]) {
    super('workflow_invalid', 'Fix the validation errors before running.')
    this.name = 'WorkflowValidationError'
  }
}
