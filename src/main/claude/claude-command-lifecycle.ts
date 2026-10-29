// Lifecycle frames can reject only unstarted sends; completed alone leaves delivery uncertain.

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
import { readClaudeFrameString } from './structured/claude-structured-init-proof'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import type { ClaudeSession, ClaudeStartedSend } from './structured/claude-structured-session-state'

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
  // Echoed sends leave both lists and cannot be rejected here.
  const waiter = [...session.dispatchWaiters, ...session.retiredDispatchWaiters].find(
    (candidate) => candidate.sentUuid === commandUuid
  )
  if (!waiter) {
    return
  }
  const state = message.state
  if (state === 'started' || (state === 'queued' && waiter.commandLifecycle !== 'started')) {
    // Redelivery can emit queued again after started.
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
  } else if (state === 'completed' && waiter.commandLifecycle !== 'started' && !waiter.retired) {
    releaseClaudeDispatchWaitersInDoubt(
      session,
      [waiter],
      DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED,
      onSettledLate
    )
  }
}

/** Local commands such as `/goal` can output before their echo; bind them to the started send. */
export function claudeStartedUnechoedSend(session: ClaudeSession): ClaudeStartedSend | null {
  const waiter = session.dispatchWaiters.find(
    (candidate) => candidate.commandLifecycle === 'started' && candidate.clientMessageId !== null
  )
  return waiter?.clientMessageId
    ? {
        clientMessageId: waiter.clientMessageId,
        ...(waiter.requestedAt === null ? {} : { requestedAt: waiter.requestedAt })
      }
    : null
}

/** Include settlements until the host hears them, avoiding a gap in dispatch ownership. */
export function claudeHeldSends(session: ClaudeSession): ReadonlySet<string> {
  return new Set([
    ...session.dispatchWaiters.flatMap((waiter) => waiter.clientMessageId ?? []),
    ...(session.unreportedSettlements ?? [])
  ])
}

/** Pending lifecycle-tracked sends must keep the idle sweep from resting the child. */
export function claudeHoldsDispatch(session: ClaudeSession | undefined): boolean {
  return session?.dispatchWaiters.some((waiter) => waiter.commandLifecycle !== undefined) ?? false
}

/** Idle can precede queued work starting; release only started, unanswered sends as uncertain. */
export function releaseClaudeDispatchesUnansweredAtIdle(
  session: ClaudeSession,
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  const started = session.dispatchWaiters.filter((waiter) => waiter.commandLifecycle === 'started')
  releaseClaudeDispatchWaitersInDoubt(session, started, DISPATCH_DOUBT_PROVIDER_IDLE, onSettledLate)
}
