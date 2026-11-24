import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  observeClaudeCommandLifecycle,
  claudeDispatchIsSteer,
  releaseClaudeDispatchesUnansweredAtIdle
} from './claude-command-lifecycle'
import { claudeSessionStateEndsTurn } from './claude-session-state-turn-over'
import { forgetRetiredWaiter } from '../dispatch/claude-structured-dispatch-waiters'
import { settleCancelledClaudeDispatchWaiters } from '../dispatch/claude-structured-dispatch'
import {
  claudeHasReplayContent,
  readClaudeMessageEnvelope
} from '../journal/claude-structured-item-translation'
import type {
  ClaudeDispatchWaiter,
  ClaudeLateDispatchOutcome,
  ClaudeSession
} from '../claude-structured-session-state'
import { readClaudeFrameString } from '../startup/claude-structured-init-proof'
import { claudeDispatchContentKey } from '../dispatch/claude-structured-dispatch-content'
import type { AgentJournalAnsweredTurnIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-types'

/** Settle provider-proven delivery independently of replay-row acceptance reconciliation. */
export type ClaudeLateDispatchSettlement = (input: ClaudeLateDispatchOutcome) => void

export type ClaudeReplayTurnOrigin = {
  requestedAt: number | null
  clientMessageId: string | null
}

export type ClaudeDispatchLifecycle = {
  observedAt: number
  onReceived: (receipt: { clientMessageId: string; fence: number }) => void
}

export function resolveClaudeReplayTurn(
  session: ClaudeSession,
  message: Record<string, unknown>,
  onSettledLate?: ClaudeLateDispatchSettlement,
  lifecycle?: ClaudeDispatchLifecycle
): ClaudeReplayTurnOrigin | null {
  if (message.type === 'command_lifecycle') {
    observeClaudeCommandLifecycle(session, message, onSettledLate, (waiter, evidence) => {
      if (!lifecycle || waiter.clientMessageId === null) {
        return
      }
      if (evidence.received) {
        lifecycle.onReceived({
          clientMessageId: waiter.clientMessageId,
          fence: waiter.dispatchFence
        })
      }
      if (evidence.started) {
        session.translator?.turnCycle.startDispatch(
          session.providerSessionId,
          waiter,
          lifecycle.observedAt
        )
      }
    })
    return null
  }
  if (claudeSessionStateEndsTurn(message)) {
    releaseClaudeDispatchesUnansweredAtIdle(session, onSettledLate)
    return null
  }
  const envelope = readClaudeMessageEnvelope(message)
  const isUserReplay =
    envelope?.role === 'user' &&
    message.parent_tool_use_id === null &&
    claudeHasReplayContent(envelope)
  const isCompletedCommand = message.type === 'result'
  if (
    (!isUserReplay && !isCompletedCommand) ||
    readClaudeFrameString(message, 'session_id') !== session.providerSessionId
  ) {
    return null
  }
  const uuid = readClaudeFrameString(message, 'uuid')
  if (!uuid) {
    return null
  }

  // Explicit correlation outranks content and queue order across identical prompts and timeout boundaries.
  const userMessageUuid = readClaudeFrameString(message, 'user_message_uuid')
  // Each folded send settles under its own UUID, never a shared result-frame alias.
  const resultUserMessageUuids = isCompletedCommand ? claudeResultUserMessageUuids(message) : []
  for (const member of resultUserMessageUuids) {
    if (member === userMessageUuid) {
      continue
    }
    const live = session.dispatchWaiters.find((candidate) => candidate.sentUuid === member)
    if (live) {
      settleLiveDispatch(session, live, member, false, onSettledLate, true)
      continue
    }
    const late = session.retiredDispatchWaiters.find((candidate) => candidate.sentUuid === member)
    if (late) {
      forgetRetiredWaiter(session, late)
      recoverLateIdentity(session, late, member, false, onSettledLate)
    }
  }
  if (userMessageUuid) {
    const exact = session.dispatchWaiters.find(
      (candidate) => candidate.sentUuid === userMessageUuid
    )
    if (exact) {
      // A Stop before Claude checked the prompt ends it unechoed; Claude lists it as dropped, never run.
      if (
        isCompletedCommand &&
        message.terminal_reason === 'aborted_streaming' &&
        !exact.acceptsResult
      ) {
        settleCancelledClaudeDispatchWaiters(session, [exact.sentUuid], onSettledLate)
        return null
      }
      return settleLiveDispatch(session, exact, uuid, isUserReplay, onSettledLate)
    }
    const retired = session.retiredDispatchWaiters.find(
      (candidate) => candidate.sentUuid === userMessageUuid
    )
    if (retired) {
      forgetRetiredWaiter(session, retired)
      recoverLateIdentity(session, retired, uuid, isUserReplay, onSettledLate)
      return null
    }
    return null
  }
  if (resultUserMessageUuids.length > 0) {
    // An explicit list is complete; queue order must not claim unnamed sends.
    return null
  }

  const exact = session.dispatchWaiters.find((candidate) => candidate.sentUuid === uuid)
  if (exact) {
    return settleLiveDispatch(session, exact, uuid, isUserReplay, onSettledLate)
  }
  const retired = session.retiredDispatchWaiters.find((candidate) => candidate.sentUuid === uuid)
  if (retired) {
    forgetRetiredWaiter(session, retired)
    recoverLateIdentity(session, retired, uuid, isUserReplay, onSettledLate)
    return null
  }

  if (isUserReplay) {
    // Older CLIs may mint replay UUIDs; join by content only with one match and no candidates across the timeout boundary.
    const replayContentKey = claudeDispatchContentKey(envelope.content)
    if (!session.replayContentFallbackBlocked && session.retiredDispatchWaiters.length === 0) {
      const compatible = session.dispatchWaiters.filter(
        (candidate) => candidate.replayContentKey === replayContentKey
      )
      if (compatible.length === 1) {
        const [candidate] = compatible
        return settleLiveDispatch(session, candidate!, uuid, true, onSettledLate)
      }
    } else if (!session.replayContentFallbackBlocked && session.dispatchWaiters.length === 0) {
      const lateCompatible = session.retiredDispatchWaiters.filter(
        (candidate) => candidate.replayContentKey === replayContentKey
      )
      if (lateCompatible.length === 1) {
        const [candidate] = lateCompatible
        forgetRetiredWaiter(session, candidate!)
        recoverLateIdentity(session, candidate!, uuid, true, onSettledLate)
        return null
      }
    }
    return null
  }
  const current = session.dispatchWaiters[0]
  if (isCompletedCommand && !current?.acceptsResult) {
    return null
  }
  // Any retired waiter makes queue-order correlation ambiguous for uncorrelated legacy results.
  if (isCompletedCommand && session.retiredDispatchWaiters.length > 0) {
    return null
  }
  // Eviction makes later queue-order joins unsafe.
  if (isCompletedCommand && session.replayContentFallbackBlocked) {
    return null
  }
  return current ? settleLiveDispatch(session, current, uuid, isUserReplay, onSettledLate) : null
}

/** Safely matched echoes inherit cycle ownership independently of their delivery UUID. */
function settleLiveDispatch(
  session: ClaudeSession,
  waiter: ClaudeDispatchWaiter,
  uuid: string,
  isUserReplay: boolean,
  onSettledLate?: ClaudeLateDispatchSettlement,
  explicitlyFolded = false
): ClaudeReplayTurnOrigin | null {
  const cycle = session.translator?.turnCycle
  const ownOpener =
    waiter.clientMessageId !== null &&
    cycle?.userItemId === agentJournalSubmissionKey(waiter.clientMessageId)
  const steers = claudeDispatchIsSteer(waiter)
  const joinsTurn =
    !ownOpener &&
    (explicitlyFolded ||
      cycle?.ownsLiveProviderCycle === true ||
      (steers && session.translator?.currentTurnId != null))
  if (isUserReplay && (ownOpener || joinsTurn)) {
    cycle?.confirmProviderCycle()
  }
  if (isUserReplay && steers && !joinsTurn && !ownOpener) {
    cycle?.suppressReopen()
  }
  settleWaiter(session, waiter, uuid, onSettledLate, joinsTurn ? joinedTurn(session) : undefined)
  return isUserReplay && !joinsTurn && !steers
    ? { requestedAt: waiter.requestedAt, clientMessageId: waiter.clientMessageId }
    : null
}

function claudeResultUserMessageUuids(message: Record<string, unknown>): string[] {
  const uuids = message.user_message_uuids
  return Array.isArray(uuids)
    ? uuids.filter((member): member is string => typeof member === 'string' && member.length > 0)
    : []
}

/** The running turn a send joined: the provider's current turn, which another send opened. */
function joinedTurn(session: ClaudeSession): AgentJournalAnsweredTurnIdentity | undefined {
  const turn = session.translator?.turnCycle.identity
  return turn ? { turn, via: 'steer' } : undefined
}

function settleWaiter(
  session: ClaudeSession,
  waiter: ClaudeDispatchWaiter,
  uuid: string,
  onSettledLate?: ClaudeLateDispatchSettlement,
  answeredInTurn?: AgentJournalAnsweredTurnIdentity
): void {
  const index = session.dispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.dispatchWaiters.splice(index, 1)
  }
  waiter.settledUuid = uuid
  waiter.resolve(uuid)
  // Admission already returned; this replay settles delivery.
  if (waiter.clientMessageId) {
    onSettledLate?.({
      clientMessageId: waiter.clientMessageId,
      providerIdentity: { provider: 'claude', sessionId: session.providerSessionId, uuid },
      ...(answeredInTurn ? { answeredInTurn } : {})
    })
  }
}

function recoverLateIdentity(
  session: ClaudeSession,
  waiter: ClaudeDispatchWaiter,
  uuid: string,
  isUserReplay: boolean,
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  if (!isUserReplay && !waiter.acceptsResult) {
    return
  }
  // Retired replays settle delivery without reopening turns.
  if (waiter.clientMessageId) {
    onSettledLate?.({
      clientMessageId: waiter.clientMessageId,
      providerIdentity: { provider: 'claude', sessionId: session.providerSessionId, uuid }
    })
  }
}

/** Retain send ownership until publication and its delivery receipts have both settled. */
export function withClaudeReplaySettlements(
  session: ClaudeSession | null,
  settlements: ClaudeLateDispatchOutcome[],
  publish: () => void,
  report: (settlement: ClaudeLateDispatchOutcome) => void
): void {
  const reported = session?.unreportedSettlements
  if (session && settlements.length > 0) {
    session.unreportedSettlements = new Set([
      ...(reported ?? []),
      ...settlements.map((settlement) => settlement.clientMessageId)
    ])
  }
  try {
    publish()
  } finally {
    try {
      for (const settlement of settlements) {
        report(settlement)
      }
    } finally {
      if (session) {
        session.unreportedSettlements = reported
      }
    }
  }
}
