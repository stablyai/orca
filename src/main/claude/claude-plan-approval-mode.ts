import type { PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import type { ClaudeSession } from './structured/claude-structured-session-state'

/** This process's requested mode, else its first init's; anything else asks for each edit. */
export function claudePlanApprovalMode(
  session: Pick<ClaudeSession, 'launchIntent' | 'firstRootInit'>
): PermissionMode {
  const mode =
    session.launchIntent?.permissionMode ?? session.firstRootInit?.permissionMode ?? 'default'
  switch (mode) {
    case 'default':
    case 'acceptEdits':
    case 'dontAsk':
    case 'auto':
    case 'bypassPermissions':
      return mode
    default:
      return 'default'
  }
}

function logPlanExitFailure(error: unknown): void {
  try {
    console.warn('[claude] leaving Plan mode after an approved plan failed:', error)
  } catch {
    // The approval stands whatever happens to this log line.
  }
}

/** Claude stays in plan after an approved ExitPlanMode until told. The request is written
 *  before the allow and never awaited, so its failure cannot hold or reject the approval. */
export function leaveClaudePlanModeOnApproval(
  session: Pick<ClaudeSession, 'launchIntent' | 'firstRootInit' | 'reportedOptions'> & {
    connection: Pick<ClaudeSession['connection'], 'setPermissionMode'>
  },
  prompt: Pick<ClaudePendingPrompt, 'toolName'>,
  reply: PermissionResult
): void {
  if (
    prompt.toolName !== 'ExitPlanMode' ||
    reply.behavior !== 'allow' ||
    session.reportedOptions.reportedPermissionMode !== 'plan'
  ) {
    return
  }
  try {
    session.connection.setPermissionMode(claudePlanApprovalMode(session)).catch(logPlanExitFailure)
  } catch (error) {
    logPlanExitFailure(error)
  }
}
