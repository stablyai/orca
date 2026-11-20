import type { PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import type { ClaudeSession } from '../claude-structured-session-state'
import {
  claudeAllowedPermissionMode,
  claudeBypassRefused,
  setClaudeAllowedPermissionMode
} from './claude-full-access-refusal'

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

/** Keep a provider's startup restriction until an approved plan successfully restores the requested policy. */
export function claudeBuildPermissionMode(
  session: Pick<ClaudeSession, 'launchIntent' | 'firstRootInit' | 'appliedInputOptions'> &
    Partial<Pick<ClaudeSession, 'bypassDisabled' | 'autoDisabled'>>
): PermissionMode {
  const opened = session.firstRootInit?.permissionMode
  const built = claudePlanApprovalMode({
    launchIntent: {
      permissionMode:
        session.appliedInputOptions.get('buildPermissionMode') ??
        // A refused Full access start opened in Claude's own fallback, not the chat's choice.
        (opened !== 'plan' && !claudeBypassRefused(session) ? opened : undefined) ??
        session.launchIntent?.permissionMode
    }
  })
  return claudeAllowedPermissionMode(session, built)
}

function logPlanExitFailure(error: unknown): void {
  try {
    console.warn('[claude] leaving Plan mode after an approved plan failed:', error)
  } catch {
    // The approval stands whatever happens to this log line.
  }
}

/** Claude stays in plan after an approved ExitPlanMode until told. The request is written
 *  before the allow and never awaited, so its failure cannot hold or reject the approval.
 *  Full access reads the mode in wire order: its presentation report can lag behind the plan. */
export function leaveClaudePlanModeOnApproval(
  session: Pick<
    ClaudeSession,
    'launchIntent' | 'firstRootInit' | 'reportedOptions' | 'orderedPermissionMode'
  > &
    Partial<Pick<ClaudeSession, 'appliedInputOptions' | 'bypassDisabled' | 'autoDisabled'>> & {
      connection: Pick<ClaudeSession['connection'], 'setPermissionMode'>
    },
  prompt: Pick<ClaudePendingPrompt, 'toolName'>,
  reply: PermissionResult
): void {
  const mode = session.orderedPermissionMode
    ? session.orderedPermissionMode()
    : session.reportedOptions.reportedPermissionMode
  if (prompt.toolName !== 'ExitPlanMode' || reply.behavior !== 'allow' || mode !== 'plan') {
    return
  }
  try {
    setClaudeAllowedPermissionMode(session, claudePlanApprovalMode(session)).then((restored) => {
      session.appliedInputOptions?.set('interactionMode', 'default')
      session.appliedInputOptions?.set('buildPermissionMode', restored)
    }, logPlanExitFailure)
  } catch (error) {
    logPlanExitFailure(error)
  }
}
