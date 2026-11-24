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
import type { StructuredAgentSessionTransitionSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-transition'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import type {
  ClaudeDispatchWaiter,
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

export type ClaudeDispatchFrameEvidence = {
  observedAt: number
  onReceived: NonNullable<StructuredAgentSessionTransitionSink['recordProviderReceipt']>
}

export function resolveClaudeDispatchLifecycle(
  session: ClaudeSession,
  message: Record<string, unknown>,
  onSettledLate: ClaudeLateDispatchSettlement | undefined,
  frame: ClaudeDispatchFrameEvidence | undefined
): void {
  if (
    frame &&
    message.state === 'started' &&
    readClaudeFrameString(message, 'session_id') === session.providerSessionId
  ) {
    session.translator?.turnCycle.echoedDispatchStart.confirm(
      readClaudeFrameString(message, 'command_uuid'),
      session.fence,
      frame.observedAt
    )
  }
  observeClaudeCommandLifecycle(session, message, onSettledLate, (waiter, evidence) => {
    if (!frame || waiter.clientMessageId === null) {
      return
    }
    if (evidence.received) {
      frame.onReceived({
        clientMessageId: waiter.clientMessageId,
        fence: waiter.dispatchFence,
        observedAt: frame.observedAt
      })
    }
    if (evidence.started) {
      session.translator?.turnCycle.startDispatch(
        session.providerSessionId,
        waiter,
        frame.observedAt
      )
    }
  })
}

function observeClaudeCommandLifecycle(
  session: ClaudeSession,
  message: Record<string, unknown>,
  onSettledLate?: ClaudeLateDispatchSettlement,
  onLiveLifecycle?: (
    waiter: ClaudeDispatchWaiter,
    evidence: { received: boolean; started: boolean }
  ) => void
): void {
  if (readClaudeFrameString(message, 'session_id') !== session.providerSessionId) {
    return
  }
  const commandUuid = readClaudeFrameString(message, 'command_uuid')
  // Echoed sends leave both lists and cannot be rejected here.
  const waiter = [...session.dispatchWaiters, ...session.retiredDispatchWaiters].find(
    (candidate) => candidate.sentUuid === commandUuid
  )
  if (!waiter) {
    return
  }
  const state = message.state
  if (state === 'started' || state === 'queued') {
    const previous = waiter.commandLifecycle
    if (previous !== 'started' && previous !== state) {
      waiter.commandLifecycle = state
      if (!waiter.retired && waiter.dispatchFence === session.fence) {
        onLiveLifecycle?.(waiter, {
          received: previous === undefined,
          started: state === 'started'
        })
      }
    }
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

export function claudeDispatchIsSteer(waiter: ClaudeDispatchWaiter): boolean {
  return waiter.steers === true || waiter.turnScoped === true
}

/** Local commands such as `/goal` can output before their echo; bind them to the started send. */
export function claudeStartedUnechoedSend(session: ClaudeSession): ClaudeStartedSend | null {
  const waiter = session.dispatchWaiters.find(
    (candidate) => candidate.commandLifecycle === 'started' && candidate.clientMessageId !== null
  )
  return waiter?.clientMessageId
    ? {
        clientMessageId: waiter.clientMessageId,
        ...(claudeDispatchIsSteer(waiter) ? { steers: true } : {}),
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

type ClaudeFrameSendFacts = { startedSend?: ClaudeStartedSend; renamedTo?: string }
// Most frames carry neither fact; this runs on every frame, streaming deltas included.
const NO_SEND_FACTS: ClaudeFrameSendFacts = Object.freeze({})

/** Send facts read when the frame arrives: its delivery can run after the send's echo settles it. */
export function claudeFrameSendFacts(
  session: ClaudeSession | null,
  message: Record<string, unknown>,
  startsTurn: boolean
): ClaudeFrameSendFacts {
  const startedSend = !startsTurn && session ? claudeStartedUnechoedSend(session) : null
  const renamedTo = claudeUserRenamedSession(session, message)
  if (!startedSend && !renamedTo) {
    return NO_SEND_FACTS
  }
  return { ...(startedSend ? { startedSend } : {}), ...(renamedTo ? { renamedTo } : {}) }
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
