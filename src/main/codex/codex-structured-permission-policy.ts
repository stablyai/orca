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
const FULL_ACCESS_POLICY = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  approvalsReviewer: 'user'
} as const

/**
 * Ask: approvals on, writes confined to the workspace.
 *
 * Why state it rather than omit it: app-server resolves an omitted field through the `config.toml`
 * it was started with, which Orca mirrors from the user's own. Measured against codex 0.153.4 —
 * with `approval_policy = "never"` in that file, a fresh thread that omits it comes up `never` +
 * `dangerFullAccess` and never prompts, and a resume inherits the policy the thread last ran with.
 *
 * Why `workspace-write` and not codex's built-in `read-only`: read-only would override a
 * deliberate `sandbox_mode = "workspace-write"` and make every file write need an approval it did
 * not need before. A sandbox mode, never a `sandboxPolicy` object, so Codex still folds in the
 * user's `[sandbox_workspace_write]` roots and network access.
 */
const ASK_POLICY = {
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
  approvalsReviewer: 'user'
} as const

/** Approve for me: Ask's sandbox and approvals, reviewed by Codex's own reviewer agent. */
const AUTO_POLICY = { ...ASK_POLICY, approvalsReviewer: 'auto_review' } as const

/**
 * A chat's permission mode as app-server thread policy, sent on `thread/start` and `thread/resume`.
 * Every field is stated for every mode: one left unsaid is what a resume inherits from the last.
 * Codex offers no edits-only mode, so anything else asks.
 */
export function codexStructuredPermissionPolicy(
  mode: AgentChatPermissionMode
): CodexStructuredPermissionPolicy {
  return mode === 'full-access' ? FULL_ACCESS_POLICY : mode === 'auto' ? AUTO_POLICY : ASK_POLICY
}
