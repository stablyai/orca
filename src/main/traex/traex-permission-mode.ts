import { traexRecord } from './traex-protocol'

export function reportedTraexPermissionMode(value: unknown): string | null {
  const result = traexRecord(value)
  const sandbox = traexRecord(result.sandbox).type
  const approval = result.approvalPolicy
  const reviewer = result.approvalsReviewer
  if (sandbox === 'readOnly' && approval === 'on-request' && reviewer === 'user') {
    return 'ask'
  }
  if (
    sandbox === 'workspaceWrite' &&
    approval === 'on-request' &&
    (reviewer === 'auto_review' || reviewer === 'guardian_subagent')
  ) {
    return 'auto'
  }
  return sandbox === 'dangerFullAccess' && approval === 'never' && reviewer === 'user'
    ? 'full-access'
    : null
}
