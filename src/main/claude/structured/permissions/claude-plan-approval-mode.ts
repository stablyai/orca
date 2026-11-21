import type { PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import type { ClaudeSession } from '../claude-structured-session-state'
import { claudeLaunchModeRefused } from './claude-full-access-refusal'
import {
  ClaudePermissionModeUnsettled,
  setClaudeAllowedPermissionMode
} from './claude-permission-mode-ladder'

/** This process's requested mode, else the mode it opened in; anything else asks for each edit. */
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

/** Keep a provider's startup restriction until an approved plan successfully restores the requested
 *  policy. A refused Full access or Approve for me chat asks for its choice each time, so Claude's
 *  answer picks the fallback rather than an earlier one that was only for now. */
export function claudeBuildPermissionMode(
  session: Pick<ClaudeSession, 'launchIntent' | 'firstRootInit' | 'appliedInputOptions'> &
    Partial<Pick<ClaudeSession, 'bypassDisabled' | 'autoDisabled' | 'autoUnsettled'>>
): PermissionMode {
  if (claudeLaunchModeRefused(session)) {
    return claudePlanApprovalMode(session)
  }
  const opened = session.firstRootInit?.permissionMode
  return claudePlanApprovalMode({
    launchIntent: {
      permissionMode:
        session.appliedInputOptions.get('buildPermissionMode') ??
        (opened !== 'plan' ? opened : undefined) ??
        session.launchIntent?.permissionMode
    }
  })
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
    setClaudeAllowedPermissionMode(session, claudePlanApprovalMode(session)).then(
      (restored) => {
        session.appliedInputOptions?.set('interactionMode', 'default')
        session.appliedInputOptions?.set('buildPermissionMode', restored)
      },
      (error: unknown) => {
        // Claude accepted a step out of Plan before a later one went unanswered: the chat has
        // left Plan, and its fallback is owed again.
        if (error instanceof ClaudePermissionModeUnsettled) {
          session.appliedInputOptions?.set('interactionMode', 'default')
          session.appliedInputOptions?.delete('buildPermissionMode')
        }
        logPlanExitFailure(error)
      }
    )
  } catch (error) {
    logPlanExitFailure(error)
  }
}
