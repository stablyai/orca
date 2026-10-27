import {
  observeClaudeCommandLifecycle,
  releaseClaudeDispatchesUnansweredAtIdle
} from './claude-command-lifecycle'
import { claudeSessionStateEndsTurn } from './claude-session-state-turn-over'
import { forgetRetiredWaiter } from './claude-structured-dispatch-waiters'
import {
  claudeHasReplayContent,
  readClaudeMessageEnvelope
} from './claude-structured-item-translation'
import type {
  ClaudeDispatchWaiter,
  ClaudeLateDispatchOutcome,
  ClaudeSession
} from './structured/claude-structured-session-state'
import { readClaudeFrameString } from './structured/claude-structured-init-proof'
import { claudeDispatchContentKey } from './claude-structured-dispatch-content'

/** Settle provider-proven delivery independently of replay-row acceptance reconciliation. */
export type ClaudeLateDispatchSettlement = (input: ClaudeLateDispatchOutcome) => void

export type ClaudeReplayTurnOrigin = {
  requestedAt: number | null
  clientMessageId: string | null
}

export function resolveClaudeReplayTurn(
  session: ClaudeSession,
  message: Record<string, unknown>,
  onSettledLate?: ClaudeLateDispatchSettlement
): ClaudeReplayTurnOrigin | null {
  if (message.type === 'command_lifecycle') {
    observeClaudeCommandLifecycle(session, message, onSettledLate)
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
      settleWaiter(session, live, member, onSettledLate)
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
      const foldReceipt = isUserReplay && claudeReplayIsFoldReceipt(session, exact, uuid)
      settleWaiter(session, exact, uuid, onSettledLate)
      return isUserReplay && !foldReceipt
        ? { requestedAt: exact.requestedAt, clientMessageId: exact.clientMessageId }
        : null
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
    const foldReceipt = isUserReplay && claudeReplayIsFoldReceipt(session, exact, uuid)
    settleWaiter(session, exact, uuid, onSettledLate)
    return isUserReplay && !foldReceipt
      ? { requestedAt: exact.requestedAt, clientMessageId: exact.clientMessageId }
      : null
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
        settleWaiter(session, candidate!, uuid, onSettledLate)
        return { requestedAt: candidate!.requestedAt, clientMessageId: candidate!.clientMessageId }
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
  const waiter = uuid ? session.dispatchWaiters.shift() : undefined
  if (waiter && uuid) {
    settleWaiter(session, waiter, uuid, onSettledLate)
    return isUserReplay
      ? { requestedAt: waiter.requestedAt, clientMessageId: waiter.clientMessageId }
      : null
  }
  return null
}

/** Adopted UUIDs after root cycle work prove folded delivery; a new root init resets this evidence. */
function claudeReplayIsFoldReceipt(
  session: ClaudeSession,
  waiter: ClaudeDispatchWaiter,
  replayUuid: string
): boolean {
  return replayUuid === waiter.sentUuid && session.translator?.openTurnInLiveProviderCycle === true
}

function claudeResultUserMessageUuids(message: Record<string, unknown>): string[] {
  const uuids = message.user_message_uuids
  return Array.isArray(uuids)
    ? uuids.filter((member): member is string => typeof member === 'string' && member.length > 0)
    : []
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
  // Admission already returned; this replay settles delivery.
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
  // Retired replays settle delivery without reopening turns.
  if (waiter.clientMessageId) {
    onSettledLate?.({
      clientMessageId: waiter.clientMessageId,
      providerIdentity: { provider: 'claude', sessionId: session.providerSessionId, uuid }
    })
  }
}
