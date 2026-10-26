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
  | {
      approvalPolicy: 'on-request'
      sandbox: 'read-only'
      approvalsReviewer: CodexApprovalsReviewer
    }

const FULL_ACCESS_POLICY = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  approvalsReviewer: 'user'
} as const

// Explicit fields prevent inheriting permissive config or previous thread policies.
/** Workspace writes need approval even when the user's configured sandbox permits them. */
const ASK_POLICY = {
  approvalPolicy: 'on-request',
  sandbox: 'read-only',
  approvalsReviewer: 'user'
} as const

// A mode preserves configured roots/network; read-only would add write approvals.
const AUTO_POLICY = {
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
  approvalsReviewer: 'auto_review'
} as const

/** Codex has no edits-only mode; unsupported modes fall back to Ask. */
export function codexStructuredPermissionPolicy(
  mode: AgentChatPermissionMode
): CodexStructuredPermissionPolicy {
  return mode === 'full-access' ? FULL_ACCESS_POLICY : mode === 'auto' ? AUTO_POLICY : ASK_POLICY
}
