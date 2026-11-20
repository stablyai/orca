import type { PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import type { ClaudeSession } from '../claude-structured-session-state'

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

/** Claude stays in plan after an approved ExitPlanMode until the allow names the build mode.
 *  The control is written first and never awaited, so its failure cannot hold the approval.
 *  A plan-started chat's report can still name the launch mode; Full access reads the wire. */
export function leaveClaudePlanModeOnApproval(
  session: Pick<
    ClaudeSession,
    'launchIntent' | 'firstRootInit' | 'reportedOptions' | 'orderedPermissionMode'
  > &
    Partial<Pick<ClaudeSession, 'appliedInputOptions'>> & {
      connection: Pick<ClaudeSession['connection'], 'setPermissionMode'>
    },
  prompt: Pick<ClaudePendingPrompt, 'toolName'>,
  reply: PermissionResult
): void {
  const reported = session.orderedPermissionMode
    ? session.orderedPermissionMode()
    : session.reportedOptions.reportedPermissionMode
  const inPlan =
    reported === 'plan' || session.appliedInputOptions?.get('interactionMode') === 'plan'
  if (prompt.toolName !== 'ExitPlanMode' || reply.behavior !== 'allow' || !inPlan) {
    return
  }
  try {
    const restored = claudeBuildPermissionMode({
      launchIntent: session.launchIntent,
      firstRootInit: session.firstRootInit,
      appliedInputOptions: session.appliedInputOptions ?? new Map()
    })
    // ExitPlanMode otherwise restores prePlanMode, which a chat opened in plan never saved, or default.
    reply.updatedPermissions = [
      ...(reply.updatedPermissions ?? []),
      { type: 'setMode', mode: restored, destination: 'session' }
    ]
    session.connection.setPermissionMode(restored).then(() => {
      session.appliedInputOptions?.set('interactionMode', 'default')
      session.appliedInputOptions?.set('buildPermissionMode', restored)
    }, logPlanExitFailure)
  } catch (error) {
    logPlanExitFailure(error)
  }
}
