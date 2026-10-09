import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import type { CodexApprovalsReviewer } from '../../shared/codex-subagent-reviewer'

export type CodexStructuredPermissionPolicy =
  | {
      approvalPolicy: 'never'
      sandbox: 'danger-full-access'
      approvalsReviewer: CodexApprovalsReviewer
    }
  | {
      approvalPolicy: 'on-request'
      sandbox: 'workspace-write'
      approvalsReviewer: CodexApprovalsReviewer
    }

/** Full access: no approval prompts, no sandbox. */
const BYPASS_POLICY = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  approvalsReviewer: 'user'
} as const

/** Explicit policy prevents the CLI configuration or resumed thread from granting more access. */
const ASK_POLICY = {
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
  approvalsReviewer: 'user'
} as const

/** Approve for me: Ask's sandbox and approvals, reviewed by Codex's auto-review agent. */
const AUTO_POLICY = { ...ASK_POLICY, approvalsReviewer: 'auto_review' } as const

/** Unsupported edits-only values use Ask rather than granting more access. */
export function codexStructuredPermissionPolicy(
  mode: AgentChatPermissionMode
): CodexStructuredPermissionPolicy {
  return mode === 'bypass' ? BYPASS_POLICY : mode === 'auto' ? AUTO_POLICY : ASK_POLICY
}
