import type { AgentChatPermissionChoice } from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { traexRecord } from './traex-protocol'

export function reportedTraexPermissionMode(value: unknown): AgentChatPermissionChoice | null {
  const result = traexRecord(value)
  // Thread open reports `sandbox`; settings updates report `sandboxPolicy`.
  const sandbox = traexRecord(result.sandbox).type ?? traexRecord(result.sandboxPolicy).type
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
