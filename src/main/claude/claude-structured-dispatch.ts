import { randomUUID } from 'node:crypto'
import {
  forgetRetiredWaiter,
  forgetWaiter,
  retireWaiter,
  waitForReplay
} from './claude-structured-dispatch-waiters'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  claudeHasReplayContent,
  readClaudeMessageEnvelope
} from './claude-structured-item-translation'
import type {
  ClaudeDispatchWaiter,
  ClaudeLateDispatchOutcome,
  ClaudeSession
} from './claude-structured-session-state'
import { readClaudeFrameString } from './claude-structured-init-proof'
import {
  claudeDispatchContentKey,
  claudeDispatchInvokesSlashCommand,
  claudeDispatchMessageContent
} from './claude-structured-dispatch-content'
import { dispatchWriteOutcomeUnknownReason } from '../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_QUEUE_FULL,
  dispatchWriteFailureReason
} from '../../shared/structured-agent-session-dispatch-rejection'
import {
  claudeUnwrittenUserMessageError,
  claudeUserMessageWasProvablyUnwritten
} from './claude-agent-sdk-user-message-queue'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'

const MAX_ACTIVE_DISPATCH_WAITERS = 64

/** Settles a provider-proven late outcome; replay rows independently reconcile acceptance. */
export type ClaudeLateDispatchSettlement = (input: ClaudeLateDispatchOutcome) => void

export type ClaudeReplayTurnOrigin = { requestedAt: number | null }

export function resolveClaudeReplayTurn(
  session: ClaudeSession,
  message: Record<string, unknown>,
  onSettledLate?: ClaudeLateDispatchSettlement
): ClaudeReplayTurnOrigin | null {
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

  // Newer SDK frames carry the client uuid that caused a turn. A correlation
  // value is authoritative: never fall back to queue order or content, since
  // identical prompts may be in flight across a timeout boundary.
  const userMessageUuid = readClaudeFrameString(message, 'user_message_uuid')
  if (userMessageUuid) {
    const exact = session.dispatchWaiters.find(
      (candidate) => candidate.sentUuid === userMessageUuid
    )
    if (exact) {
      settleWaiter(session, exact, uuid, onSettledLate)
      return isUserReplay ? { requestedAt: exact.requestedAt } : null
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

  const exact = session.dispatchWaiters.find((candidate) => candidate.sentUuid === uuid)
  if (exact) {
    settleWaiter(session, exact, uuid, onSettledLate)
    return isUserReplay ? { requestedAt: exact.requestedAt } : null
  }
  const retired = session.retiredDispatchWaiters.find((candidate) => candidate.sentUuid === uuid)
  if (retired) {
    forgetRetiredWaiter(session, retired)
    recoverLateIdentity(session, retired, uuid, isUserReplay, onSettledLate)
    return null
  }

  if (isUserReplay) {
    // Compatibility CLIs may mint a new replay uuid instead of echoing the
    // client uuid. Content is an acceptable join only when it is the sole
    // candidate on one side of the timeout boundary; with active and retired
    // candidates present, identical prompts are intentionally left unknown.
    const replayContentKey = claudeDispatchContentKey(envelope.content)
    if (!session.replayContentFallbackBlocked && session.retiredDispatchWaiters.length === 0) {
      const compatible = session.dispatchWaiters.filter(
        (candidate) => candidate.replayContentKey === replayContentKey
      )
      if (compatible.length === 1) {
        const [candidate] = compatible
        settleWaiter(session, candidate!, uuid, onSettledLate)
        return { requestedAt: candidate!.requestedAt }
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
  // A legacy result has no dispatch correlation. Any retired waiter makes queue order ambiguous,
  // even when the retired dispatch was an ordinary turn rather than a slash command.
  if (isCompletedCommand && session.retiredDispatchWaiters.length > 0) {
    return null
  }
  // Once an eviction occurred, a fresh result uuid cannot be joined to a waiter by queue order.
  if (isCompletedCommand && session.replayContentFallbackBlocked) {
    return null
  }
  const waiter = uuid ? session.dispatchWaiters.shift() : undefined
  if (waiter && uuid) {
    settleWaiter(session, waiter, uuid, onSettledLate)
    return isUserReplay ? { requestedAt: waiter.requestedAt } : null
  }
  return null
}

function settleWaiter(
  session: ClaudeSession,
  waiter: ClaudeDispatchWaiter,
  uuid: string,
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  const index = session.dispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.dispatchWaiters.splice(index, 1)
  }
  waiter.settledUuid = uuid
  waiter.resolve(uuid)
  // Dispatch returned on admission, so the replay is what settles delivery.
  if (waiter.clientMessageId) {
    onSettledLate?.({
      clientMessageId: waiter.clientMessageId,
      providerIdentity: { provider: 'claude', sessionId: session.providerSessionId, uuid }
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
  // The provider acted on this dispatch, so the send it came from is delivered.
  // A retired replay settles delivery only; it cannot reopen a turn.
  if (waiter.clientMessageId) {
    onSettledLate?.({
      clientMessageId: waiter.clientMessageId,
      providerIdentity: { provider: 'claude', sessionId: session.providerSessionId, uuid }
    })
  }
}

export function settleCancelledClaudeDispatchWaiters(
  session: ClaudeSession,
  cancelledUuids: readonly string[],
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  const cancelled = new Set(cancelledUuids)
  const activeWaiters = session.dispatchWaiters.filter((waiter) => cancelled.has(waiter.sentUuid))
  const retiredWaiters = session.retiredDispatchWaiters.filter((waiter) =>
    cancelled.has(waiter.sentUuid)
  )
  for (const waiter of activeWaiters) {
    forgetWaiter(session, waiter)
    waiter.resolve(null)
  }
  for (const waiter of retiredWaiters) {
    forgetRetiredWaiter(session, waiter)
  }
  for (const waiter of [...activeWaiters, ...retiredWaiters]) {
    if (waiter.clientMessageId) {
      onSettledLate?.({
        clientMessageId: waiter.clientMessageId,
        state: 'rejected',
        reason: DISPATCH_REJECTED_CANCELLED
      })
    }
  }
}

/** Nothing expires a waiter, so the child's death is what ends every live one.
 *  Retired rather than dropped: their identities stay joinable, bounded by
 *  `MAX_RETIRED_DISPATCH_WAITERS`. */
export function retireClaudeDispatchWaiters(session: ClaudeSession): void {
  for (const waiter of session.dispatchWaiters.splice(0)) {
    retireWaiter(session, waiter)
    waiter.resolve(null)
  }
}

export async function dispatchClaudeTurn(
  session: ClaudeSession,
  input: { clientMessageId?: string; body: AgentJournalMessageItem; requestedAt?: number },
  beforeDispatch?: () => Promise<void>
): Promise<AgentSessionDispatchOutcome> {
  let content: unknown[]
  try {
    content = await claudeDispatchMessageContent(input.body)
  } catch (error) {
    return { state: 'rejected', reason: (error as Error).message }
  }
  if (session.dispatchWaiters.length >= MAX_ACTIVE_DISPATCH_WAITERS) {
    return { state: 'rejected', reason: DISPATCH_REJECTED_QUEUE_FULL }
  }
  // Read the sent content, not the journal blocks: only the mapped trailing prompt decides
  // whether Claude runs a command, so the two cannot disagree about which frame settles this.
  const acceptsResult = claudeDispatchInvokesSlashCommand(content)
  const sentUuid = randomUUID()
  const arm = () => {
    ++session.dispatchSequence
    return waitForReplay(
      session,
      acceptsResult,
      sentUuid,
      claudeDispatchContentKey(content),
      input.clientMessageId ?? null,
      input.requestedAt ?? null
    )
  }
  const pending = { replay: beforeDispatch ? undefined : arm() }
  const authorize = beforeDispatch
    ? async () => {
        await beforeDispatch()
        if (session.dispatchWaiters.length >= MAX_ACTIVE_DISPATCH_WAITERS) {
          throw claudeUnwrittenUserMessageError(new Error(DISPATCH_REJECTED_QUEUE_FULL))
        }
        pending.replay = arm()
      }
    : undefined
  try {
    const message = {
      type: 'user',
      uuid: sentUuid,
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: session.providerSessionId
    }
    await (authorize
      ? session.connection.send(message, authorize)
      : session.connection.send(message))
  } catch (error) {
    const replay = pending.replay
    if (!replay) {
      if (error instanceof AgentSessionPreDispatchError) {
        throw error
      }
      return { state: 'rejected', reason: dispatchWriteFailureReason(error) }
    }
    const waiter = replay.waiter
    if (waiter.settledUuid) {
      const uuid = await replay.promise
      if (uuid) {
        return {
          state: 'accepted',
          providerIdentity: { provider: 'claude', sessionId: session.providerSessionId, uuid }
        }
      }
    }
    if (claudeUserMessageWasProvablyUnwritten(error)) {
      forgetWaiter(session, waiter)
      forgetRetiredWaiter(session, waiter)
      waiter.resolve(null)
      // The frame was never handed to the SDK's input pump, so this is not doubt:
      // the message provably did not happen, which is what `rejected` means.
      return { state: 'rejected', reason: dispatchWriteFailureReason(error) }
    }
    if (!waiter.retired) {
      retireWaiter(session, waiter)
      waiter.resolve(null)
    }
    return { state: 'unknown', reason: dispatchWriteOutcomeUnknownReason(error) }
  }
  // The write is the admission signal. Awaiting the echo here would block on the
  // turn already running, which is why the deadline this replaces kept declaring
  // doubt about messages that were delivered. `settleWaiter` finishes the job.
  return { state: 'admitted' }
}
