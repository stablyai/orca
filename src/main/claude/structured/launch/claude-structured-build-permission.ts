import { setTimeout as delay } from 'node:timers/promises'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { claudeBuildPermissionMode } from '../permissions/claude-plan-approval-mode'
import { journalClaudeSessionPermissionNotice } from '../permissions/claude-full-access-refusal-notice'
import {
  claudePermissionPickHolds,
  recordClaudeBuildMode
} from '../permissions/claude-permission-picks'
import {
  claudeAutoFallbackReason,
  claudeBypassRefused,
  claudeInPlan,
  claudeOwesPermissionFallback
} from '../permissions/claude-full-access-refusal'
import {
  ClaudePermissionModeUnsettled,
  recordClaudeBuildPermissionMode,
  setClaudeAllowedPermissionMode
} from '../permissions/claude-permission-mode-ladder'
import type { ClaudeSession } from '../claude-structured-session-state'
import {
  askKeptBypassLeavingPlan,
  sendKeptPickMadeLeavingPlan
} from '../../relay/claude-kept-permission'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'

/** A send's Build mode: leaving Plan, or the fallback a refused chat owes. The send's abort
 *  withholds whatever of it Claude hasn't been sent yet. */
export async function applyClaudeBuildInteractionMode(
  session: ClaudeSession,
  interactionMode: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  await waitForClaudeStartupSettings(session, signal)
  const leavingPlan = claudeInPlan(session)
  const asked = leavingPlan ? askKeptBypassLeavingPlan(session, timeoutMs, signal) : undefined
  if (asked) {
    await waitForPromiseWithSignal(asked, signal)
  }
  const refused = claudeBypassRefused(session) || claudeAutoFallbackReason(session) !== null
  // A live pick during this write goes out behind it and records its own mode.
  const holds = claudePermissionPickHolds(session)
  // A refused chat already running its fallback needs no write.
  const write =
    !leavingPlan && refused && !claudeOwesPermissionFallback(session)
      ? null
      : writeClaudeBuildMode(session, timeoutMs, !leavingPlan && refused, holds, signal)
  const request = session.permissionModeRequests
  const written = write && (await waitForPromiseWithSignal(write, signal))
  const sent = leavingPlan
    ? await waitForPromiseWithSignal(
        sendKeptPickMadeLeavingPlan(session, written ?? null, holds, timeoutMs, signal),
        signal
      )
    : { mode: written ?? null, holds }
  // A kept pick's own write answered last; otherwise a newer request decides the mode.
  if (sent.holds !== holds || session.permissionModeRequests === request) {
    session.appliedInputOptions.set('interactionMode', interactionMode)
    if (sent.mode && sent.holds()) {
      recordClaudeBuildPermissionMode(session, sent.mode)
    }
  }
}

const CLAUDE_STARTUP_SETTINGS_WAIT_MS = 5_000

/** A failed switch leaves Claude's mode unknown, so the recorded fallback goes: the warning waits
 *  and the next input asks again. It fails the input only where the chat may still be in Plan,
 *  unless Claude accepted a step out of it, or where the chat picked the mode itself. */
function writeClaudeBuildMode(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  tolerate: boolean,
  holds: () => boolean,
  signal: AbortSignal | undefined
): Promise<PermissionMode | null | undefined> {
  const write = setClaudeAllowedPermissionMode(session, claudeBuildPermissionMode(session), {
    timeoutMs,
    signal
  })
  const request = session.permissionModeRequests
  return write.catch((error: unknown) => {
    if (session.permissionModeRequests !== request) {
      return
    }
    if (!tolerate && !(error instanceof ClaudePermissionModeUnsettled)) {
      throw error
    }
    recordClaudeBuildMode(session, holds, null)
    return null
  })
}

async function waitForClaudeStartupSettings(
  session: ClaudeSession,
  signal: AbortSignal | undefined
): Promise<void> {
  const intent = session.launchIntent?.permissionMode
  const waitForSettings =
    (intent === 'bypassPermissions' &&
      session.bypassDisabled === undefined &&
      !session.firstRootInit) ||
    (intent === 'auto' &&
      session.autoDisabled === undefined &&
      // Already running its Ask fallback, a send owes no write; the reason's row waits on its own.
      session.appliedInputOptions.get('buildPermissionMode') !== 'default' &&
      session.firstRootInit?.permissionMode !== 'auto' &&
      !claudeInPlan(session))
  const pending = session.startupSettings
  if (!waitForSettings || !pending) {
    return
  }
  await waitForPromiseWithSignal(
    Promise.race([
      pending,
      delay(CLAUDE_STARTUP_SETTINGS_WAIT_MS, undefined, { ref: false, signal })
    ]),
    signal
  )
  if (intent === 'auto' && session.startupSettings === pending) {
    session.startupSettings = undefined
    if (claudeAutoFallbackReason(session) === 'started-outside') {
      journalClaudeSessionPermissionNotice(session)
    }
  }
}

export async function applyClaudePermissionFallback(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  await waitForClaudeStartupSettings(session, signal)
  if (!claudeOwesPermissionFallback(session)) {
    return
  }
  const holds = claudePermissionPickHolds(session)
  const write = writeClaudeBuildMode(session, timeoutMs, true, holds, signal)
  const request = session.permissionModeRequests
  const mode = await waitForPromiseWithSignal(write, signal)
  if (mode && holds() && session.permissionModeRequests === request) {
    recordClaudeBuildPermissionMode(session, mode)
  }
}
