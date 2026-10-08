import { actionsUrl } from '../../../../shared/github/actions-web-url'
import type { ActionsRun, ActionsWorkflow } from '../../../../shared/github/actions-types'
import { nullableString } from '../check/check-detail-field-mapping'

/** Reject non-object API rows instead of letting malformed payloads reach field mapping. */
export function actionsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid GitHub Actions response')
  }
  return Object.fromEntries(Object.entries(value))
}
/** Require a positive safe integer for identifiers used in GitHub API paths. */
export function actionsNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Invalid GitHub Actions identifier')
  }
  return value
}
/** Represent absent or malformed counts as unknown, preserving zero as a valid count. */
export function actionsCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
/** Validate required run identifiers and tolerate missing optional metadata from older GitHub hosts. */
export function mapActionsRun(value: unknown): ActionsRun {
  const run = actionsRecord(value)
  return {
    id: actionsNumber(run.id),
    workflowPath: nullableString(run.path),
    workflowId: actionsNumber(run.workflow_id),
    runNumber: actionsNumber(run.run_number),
    runAttempt: run.run_attempt === undefined ? 1 : actionsNumber(run.run_attempt),
    name: nullableString(run.name) ?? 'Workflow',
    displayTitle: nullableString(run.display_title) ?? nullableString(run.name) ?? 'Workflow',
    headBranch: nullableString(run.head_branch),
    headSha: nullableString(run.head_sha),
    event: nullableString(run.event),
    actor:
      run.actor && typeof run.actor === 'object'
        ? nullableString(actionsRecord(run.actor).login)
        : null,
    status: nullableString(run.status),
    conclusion: nullableString(run.conclusion),
    htmlUrl: actionsUrl(run.html_url),
    createdAt: nullableString(run.created_at),
    updatedAt: nullableString(run.updated_at),
    runStartedAt: nullableString(run.run_started_at)
  }
}
/** Validate the workflow identifier while retaining unavailable display metadata as nullable fields. */
export function mapActionsWorkflow(value: unknown): ActionsWorkflow {
  const workflow = actionsRecord(value)
  return {
    id: actionsNumber(workflow.id),
    name: nullableString(workflow.name) ?? 'Workflow',
    path: nullableString(workflow.path),
    state: nullableString(workflow.state)
  }
}
