import type { PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSessionPromptResponse } from '../../../../shared/agent-session/agent-session-question-answer'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import type { ClaudeSession } from '../claude-structured-session-state'

/** Active build mode override, else requested mode, else first init's; anything else asks for each edit. */
export function claudePlanApprovalMode(
  session: Pick<ClaudeSession, 'launchIntent' | 'firstRootInit'> &
    Partial<Pick<ClaudeSession, 'appliedInputOptions'>>
): PermissionMode {
  const mode =
    session.appliedInputOptions?.get('buildPermissionMode') ??
    session.launchIntent?.permissionMode ??
    session.firstRootInit?.permissionMode ??
    'default'
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
  session: Pick<ClaudeSession, 'launchIntent' | 'firstRootInit' | 'appliedInputOptions'>
): PermissionMode {
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

function approvedPlanPermissionMode(
  session: Pick<ClaudeSession, 'launchIntent' | 'firstRootInit'> &
    Partial<Pick<ClaudeSession, 'appliedInputOptions'>>,
  response?: AgentSessionPromptResponse
): PermissionMode {
  if (response?.kind === 'option') {
    if (response.optionId === 'allowAcceptEdits') {
      return 'acceptEdits'
    }
    if (response.optionId === 'allowAsk') {
      return 'default'
    }
  }
  return claudePlanApprovalMode(session)
}

/** Claude stays in plan after an approved ExitPlanMode until told. The request is written
 *  before the allow and never awaited, so its failure cannot hold or reject the approval.
 *  Full access reads the mode in wire order: its presentation report can lag behind the plan. */
export function leaveClaudePlanModeOnApproval(
  session: Pick<
    ClaudeSession,
    'launchIntent' | 'firstRootInit' | 'reportedOptions' | 'orderedPermissionMode'
  > &
    Partial<Pick<ClaudeSession, 'appliedInputOptions'>> & {
      connection: Pick<ClaudeSession['connection'], 'setPermissionMode'>
    },
  prompt: Pick<ClaudePendingPrompt, 'toolName'>,
  reply: PermissionResult,
  response?: AgentSessionPromptResponse
): void {
  const mode = session.orderedPermissionMode
    ? session.orderedPermissionMode()
    : session.reportedOptions.reportedPermissionMode
  if (prompt.toolName !== 'ExitPlanMode' || reply.behavior !== 'allow' || mode !== 'plan') {
    return
  }
  try {
    const restored = approvedPlanPermissionMode(session, response)
    session.connection.setPermissionMode(restored).then(() => {
      session.appliedInputOptions?.set('interactionMode', 'default')
      session.appliedInputOptions?.set('buildPermissionMode', restored)
    }, logPlanExitFailure)
  } catch (error) {
    logPlanExitFailure(error)
  }
}
