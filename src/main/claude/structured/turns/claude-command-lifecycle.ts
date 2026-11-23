// Lifecycle frames can reject only unstarted sends; completed alone leaves delivery uncertain.

import {
  agentSessionFailureFact,
  type SubmissionRejectionKind
} from '../../../../shared/agent-session/failures/agent-session-failure'
import {
  DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED,
  DISPATCH_DOUBT_PROVIDER_IDLE
} from '../../../native-chat/agent-session-journal/projection/journal-dispatch-doubt-reasons'
import {
  rejectClaudeDispatchWaiters,
  releaseClaudeDispatchWaitersInDoubt
} from '../dispatch/claude-structured-dispatch'
import { readClaudeFrameString } from '../startup/claude-structured-init-proof'
import { claudeText } from '../journal/claude-structured-item-translation'
import { isRootClaudeFrame } from './claude-turn-opening'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import type {
  ClaudeHandedSends,
  ClaudeSession,
  ClaudeStartedSend
} from '../claude-structured-session-state'

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

/** Claude also announces resume replays, hook titles and Orca's own renames; only a title inside the
 *  user's started rename send is the user's. */
function claudeUserRenamedSession(
  session: ClaudeSession | null,
  message: Record<string, unknown>
): string | null {
  if (
    !session ||
    message.type !== 'system' ||
    message.subtype !== 'session_title_changed' ||
    !isRootClaudeFrame(message) ||
    !session.dispatchWaiters.some(
      (waiter) => waiter.renamesSession && waiter.commandLifecycle === 'started'
    )
  ) {
    return null
  }
  return claudeText(message.title)
}

type ClaudeFrameSendFacts = {
  startedSend?: ClaudeStartedSend
  renamedTo?: string
  handedSends?: ClaudeHandedSends
  handedPending?: true
}
// Most frames carry neither fact; this runs on every frame, streaming deltas included.
const NO_SEND_FACTS: ClaudeFrameSendFacts = Object.freeze({})
const HANDED_PENDING: ClaudeFrameSendFacts = Object.freeze({ handedPending: true })

/** Send facts read when the frame arrives: its delivery can run after the send's echo settles it. */
export function claudeFrameSendFacts(
  session: ClaudeSession | null,
  message: Record<string, unknown>,
  startsTurn: boolean
): ClaudeFrameSendFacts {
  const startedSend = !startsTurn && session ? claudeStartedUnechoedSend(session) : null
  const renamedTo = claudeUserRenamedSession(session, message)
  // Read only where a launch is stamped, so other frames build nothing.
  const handedSends =
    message.type === 'system' && message.subtype === 'task_started'
      ? claudeHandedSends(session)
      : undefined
  const pending = claudeHandsPending(session)
  if (!startedSend && !renamedTo && !handedSends) {
    return pending ? HANDED_PENDING : NO_SEND_FACTS
  }
  return {
    ...(startedSend ? { startedSend } : {}),
    ...(renamedTo ? { renamedTo } : {}),
    ...(handedSends ? { handedSends } : {}),
    ...(pending ? { handedPending: true as const } : {})
  }
}

/** Orca holds a send it handed Claude and hasn't seen reported settled (the list below is not
 *  empty), or has no session to tell: checked on every frame, so it builds nothing. */
function claudeHandsPending(session: ClaudeSession | null): boolean {
  return (
    !session ||
    session.dispatchWaiters.length > 0 ||
    session.retiredDispatchWaiters.length > 0 ||
    (session.unreportedSettlements?.size ?? 0) > 0
  )
}

/** Every send Orca has handed Claude and not seen reported settled: waiting in any state (queued,
 *  started, steering), retired in doubt, or settled by the frame in hand. Read from Orca's own list,
 *  not Claude's echoes, which can come after Claude acted on the send. No session names none. */
export function claudeHandedSends(session: ClaudeSession | null): ClaudeHandedSends {
  if (!session) {
    return { ids: [], unnamed: true }
  }
  const waiters = [...session.dispatchWaiters, ...session.retiredDispatchWaiters]
  const ids = new Set(waiters.flatMap((waiter) => waiter.clientMessageId ?? []))
  for (const id of session.unreportedSettlements ?? []) {
    ids.add(id)
  }
  return {
    ids: [...ids],
    unnamed: waiters.some((waiter) => waiter.clientMessageId === null)
  }
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
