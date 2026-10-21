// Which dispatch a provider frame settles, and whether it opens a turn.
//
// A replay or result is joined to its waiter by the client uuid Claude echoes.
// A send Claude FOLDS into the running request cycle is replayed mid-cycle with
// the client uuid adopted: once that cycle has done work, that replay is a
// delivery receipt and opens no boundary. A `command_lifecycle` frame opens no turn; it and the
// CLI going idle settle sends the CLI took but never echoed (`claude-command-lifecycle.ts`).

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
} from './claude-structured-session-state'
import { readClaudeFrameString } from './claude-structured-init-proof'
import { claudeDispatchContentKey } from './claude-structured-dispatch-content'

/** Settles a provider-proven late outcome; replay rows independently reconcile acceptance. */
export type ClaudeLateDispatchSettlement = (input: ClaudeLateDispatchOutcome) => void

export type ClaudeReplayTurnOrigin = {
  requestedAt: number | null
  /** The submission this replay acknowledged, which opens the turn; null for a provider-control turn. */
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

  // Newer SDK frames carry the client uuid that caused a turn. A correlation
  // value is authoritative: never fall back to queue order or content, since
  // identical prompts may be in flight across a timeout boundary.
  const userMessageUuid = readClaudeFrameString(message, 'user_message_uuid')
  // A folded turn's result names every send it ran under `user_message_uuids`.
  // Each member settles its own waiter under its own uuid — the result frame's
  // uuid is never adopted as a shared alias for multiple submissions.
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
    // The plural list is this result's complete correlation; queue order must
    // not join anyone it did not name.
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
    return isUserReplay
      ? { requestedAt: waiter.requestedAt, clientMessageId: waiter.clientMessageId }
      : null
  }
  return null
}

/** The provider's own cycle state decides a fold: the CLI folds a send into the
 *  request cycle that is running when the send arrives, and it replays a folded
 *  send mid-cycle with the client uuid ADOPTED (measured: fold-fresh/-resumed,
 *  two-steers, early-steer). So an adopted replay after the running cycle has
 *  done work is a delivery receipt, not a turn boundary; a cycle's first send is
 *  its opener. Adoption is the capability check, read off the frame itself: a
 *  CLI that mints fresh replay uuids never qualifies. A new cycle announces
 *  itself with a root init (per-turn, measured), so a lost result cannot leave a
 *  stale turn swallowing the next turn's replay. */
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
