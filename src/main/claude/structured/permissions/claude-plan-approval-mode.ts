import type { PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import type { ClaudeSession } from '../claude-structured-session-state'
import { claudeBypassRefused } from './claude-full-access-refusal'
import {
  ClaudePermissionModeUnsettled,
  setClaudeAllowedPermissionMode
} from './claude-permission-mode-ladder'
import { claudePermissionPickHolds } from './claude-permission-picks'

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
 *  policy. A refused Full access chat asks for Full access each time, so Claude's answer picks the
 *  fallback rather than an earlier one that was only for now. */
export function claudeBuildPermissionMode(
  session: Pick<ClaudeSession, 'launchIntent' | 'firstRootInit' | 'appliedInputOptions'> &
    Partial<Pick<ClaudeSession, 'bypassDisabled'>>
): PermissionMode {
  if (claudeBypassRefused(session)) {
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

/** Sessions whose approved plan's exit is in flight: Plan is being left already. */
const exitingPlan = new WeakSet<Pick<ClaudeSession, 'launchIntent'>>()

/** A live pick made now goes out behind the exit instead of waiting for Plan to be left. */
export function claudeLeavingPlanOnApproval(session: Pick<ClaudeSession, 'launchIntent'>): boolean {
  return exitingPlan.has(session)
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
    | 'launchIntent'
    | 'firstRootInit'
    | 'reportedOptions'
    | 'orderedPermissionMode'
    | 'permissionPick'
  > &
    Partial<Pick<ClaudeSession, 'appliedInputOptions' | 'bypassDisabled' | 'autoDisabled'>> & {
      connection: Pick<ClaudeSession['connection'], 'setPermissionMode'>
    },
  prompt: Pick<ClaudePendingPrompt, 'toolName'>,
  reply: PermissionResult,
  /** Written first, ahead of the allow: a kept agent's Full access picked in Plan is asked of Claude. */
  askFirst?: () => Promise<void> | undefined
): void {
  const mode = session.orderedPermissionMode
    ? session.orderedPermissionMode()
    : session.reportedOptions.reportedPermissionMode
  if (prompt.toolName !== 'ExitPlanMode' || reply.behavior !== 'allow' || mode !== 'plan') {
    return
  }
  const leave = (): Promise<void> => {
    const holds = claudePermissionPickHolds(session)
    return setClaudeAllowedPermissionMode(session, claudePlanApprovalMode(session)).then(
      (restored) => {
        session.appliedInputOptions?.set('interactionMode', 'default')
        // A kept agent's pick made while this was in flight was only recorded (the chat still
        // looked in Plan), so it goes out now rather than leaving the older mode running.
        if (!holds()) {
          return leave()
        }
        session.appliedInputOptions?.set('buildPermissionMode', restored)
        return undefined
      }
    )
  }
  try {
    exitingPlan.add(session)
    const asked = askFirst?.()
    ;(asked ? asked.then(leave) : leave())
      .catch((error: unknown) => {
        // Claude accepted a step out of Plan before a later one went unanswered: the chat has
        // left Plan, and its fallback is owed again.
        if (error instanceof ClaudePermissionModeUnsettled) {
          session.appliedInputOptions?.set('interactionMode', 'default')
          session.appliedInputOptions?.delete('buildPermissionMode')
        }
        logPlanExitFailure(error)
      })
      .finally(() => exitingPlan.delete(session))
  } catch (error) {
    exitingPlan.delete(session)
    logPlanExitFailure(error)
  }
}
