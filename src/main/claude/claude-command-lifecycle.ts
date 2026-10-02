// What Claude's per-command `command_lifecycle` frames (msg_lifecycle_v1) settle.
//
// A terminal state for a command that never started is a verdict: `cancelled` was withdrawn,
// `discarded` was dropped when the CLI ended its session, `refused` was declined before it
// queued. None ran. After `started`, 2.1.280 sends only `cancelled`, when an interrupt or a hard
// failure ends the turn (measured), so the send may be in the conversation: any end is doubt.
// An unstarted send's `cancelled` lands before the Stop's answer, so it settles if that is lost.

import {
  agentSessionFailureFact,
  type SubmissionRejectionKind
} from '../../shared/agent-session-failure'
import {
  DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED,
  DISPATCH_DOUBT_PROVIDER_IDLE
} from '../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import {
  rejectClaudeDispatchWaiters,
  releaseClaudeDispatchWaitersInDoubt
} from './claude-structured-dispatch'
import { readClaudeFrameString } from './claude-structured-init-proof'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import type { ClaudeSession } from './claude-structured-session-state'

const UNSTARTED_VERDICT = {
  cancelled: 'cancelled',
  discarded: 'notDelivered',
  refused: 'providerRejected'
} satisfies Record<string, SubmissionRejectionKind>

function isTerminalState(state: unknown): state is keyof typeof UNSTARTED_VERDICT {
  return state === 'cancelled' || state === 'discarded' || state === 'refused'
}

export function observeClaudeCommandLifecycle(
  session: ClaudeSession,
  message: Record<string, unknown>,
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  const commandUuid = readClaudeFrameString(message, 'command_uuid')
  // An echoed send has left both lists, so nothing here can reach a delivered message.
  const waiter = [...session.dispatchWaiters, ...session.retiredDispatchWaiters].find(
    (candidate) => candidate.sentUuid === commandUuid
  )
  if (!waiter) {
    return
  }
  const state = message.state
  if (state === 'started' || (state === 'queued' && waiter.commandLifecycle !== 'started')) {
    // Forward only: a redelivered command re-emits `queued`, but it has still started.
    waiter.commandLifecycle = state
  } else if (isTerminalState(state) && waiter.commandLifecycle === 'started') {
    releaseClaudeDispatchWaitersInDoubt(
      session,
      [waiter],
      DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED,
      onSettledLate
    )
  } else if (isTerminalState(state)) {
    rejectClaudeDispatchWaiters(
      session,
      [waiter.sentUuid],
      agentSessionFailureFact(UNSTARTED_VERDICT[state]),
      onSettledLate
    )
  }
}

/** A send the CLI took, until its echo, a terminal state or exit: the sweep must not rest its child. */
export function claudeHoldsDispatch(session: ClaudeSession): boolean {
  return session.dispatchWaiters.some((waiter) => waiter.commandLifecycle !== undefined)
}

/**
 * At idle, only a `started` send still unanswered is doubt: a turn that threw leaves it with no
 * terminal state. A `queued` one may still start: 2.1.280's code idles before re-reading its queue.
 */
export function releaseClaudeDispatchesUnansweredAtIdle(
  session: ClaudeSession,
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  const started = session.dispatchWaiters.filter((waiter) => waiter.commandLifecycle === 'started')
  releaseClaudeDispatchWaitersInDoubt(session, started, DISPATCH_DOUBT_PROVIDER_IDLE, onSettledLate)
}
