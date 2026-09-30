import { randomUUID } from 'node:crypto'
import {
  forgetRetiredWaiter,
  forgetWaiter,
  retireWaiter,
  waitForReplay
} from './claude-structured-dispatch-waiters'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeSession } from './claude-structured-session-state'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import {
  claudeDispatchContentKey,
  claudeDispatchContentRejection,
  claudeDispatchInvokesSlashCommand,
  claudeDispatchMessageContent,
  claudeDispatchRejection
} from './claude-structured-dispatch-content'
import { dispatchWriteOutcomeUnknownReason } from '../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import { DISPATCH_REJECTED_QUEUE_FULL } from '../../shared/structured-agent-session-dispatch-rejection'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import type { AgentJournalDispatchRejection } from '../../shared/agent-session-failure-words'
import {
  claudeUnwrittenUserMessageError,
  claudeUserMessageWasProvablyUnwritten
} from './claude-agent-sdk-user-message-queue'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import {
  claudeStartupFailureFact,
  failClaudeStartup
} from './claude-structured-session-startup-state'

const MAX_ACTIVE_DISPATCH_WAITERS = 64

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
        ...claudeDispatchRejection(agentSessionFailureFact('cancelled'))
      })
    }
  }
}

/** Nothing expires a waiter, so the child's death is what ends every live one.
 *  Retired rather than dropped: their identities stay joinable, bounded by
 *  `MAX_RETIRED_DISPATCH_WAITERS`. */
export function retireClaudeDispatchWaiters(session: ClaudeSession): void {
  failClaudeStartup(session, new Error('claude stream-json ended before startup completed'))
  for (const waiter of session.dispatchWaiters.splice(0)) {
    retireWaiter(session, waiter)
    waiter.resolve(null)
  }
}

/** The row keeps only the marker released clients hide; why the write failed belongs in the log. */
function claudeWriteFailureRejection(error: unknown): AgentJournalDispatchRejection {
  console.warn('[claude-dispatch] message could not be handed to Claude:', error)
  return claudeDispatchRejection(agentSessionFailureFact('writeFailed'))
}

export async function dispatchClaudeTurn(
  session: ClaudeSession,
  input: {
    clientMessageId?: string
    body: AgentJournalMessageItem
    requestedAt?: number
    /** The frame's uuid, for a caller that correlates the provider's answer to it. */
    sentUuid?: string
  },
  beforeDispatch?: () => Promise<void>
): Promise<AgentSessionDispatchOutcome> {
  let content: unknown[]
  try {
    content = await claudeDispatchMessageContent(input.body)
  } catch (error) {
    return { state: 'rejected', ...claudeDispatchContentRejection(error) }
  }
  if (session.dispatchWaiters.length >= MAX_ACTIVE_DISPATCH_WAITERS) {
    return { state: 'rejected', ...claudeDispatchRejection(agentSessionFailureFact('queueFull')) }
  }
  const startupFailure = claudeStartupFailureFact(session)
  if (startupFailure) {
    return { state: 'rejected', ...claudeDispatchRejection(startupFailure) }
  }
  // Read the sent content, not the journal blocks: only the mapped trailing prompt decides
  // whether Claude runs a command, so the two cannot disagree about which frame settles this.
  const acceptsResult = claudeDispatchInvokesSlashCommand(content)
  const sentUuid = input.sentUuid ?? randomUUID()
  const arm = () => {
    ++session.dispatchSequence
    // A context report asked for before this send may land after it and misstate the context.
    session.translator?.markContextActivity()
    return waitForReplay(
      session,
      acceptsResult,
      sentUuid,
      claudeDispatchContentKey(content),
      input.clientMessageId ?? null,
      input.requestedAt ?? null
    )
  }
  const message = {
    type: 'user',
    uuid: sentUuid,
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: session.providerSessionId
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
    await (authorize
      ? session.connection.send(message, authorize)
      : session.connection.send(message))
  } catch (error) {
    const replay = pending.replay
    if (!replay) {
      if (error instanceof AgentSessionPreDispatchError) {
        throw error
      }
      return { state: 'rejected', ...claudeWriteFailureRejection(error) }
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
      return { state: 'rejected', ...claudeWriteFailureRejection(error) }
    }
    if (!waiter.retired) {
      retireWaiter(session, waiter)
      waiter.resolve(null)
    }
    return { state: 'unknown', reason: dispatchWriteOutcomeUnknownReason(error) }
  }
  // The write is the admission signal. Awaiting the echo here would block on the
  // turn already running, which is why the deadline this replaces kept declaring
  // doubt about messages that were delivered. The replay resolution
  // (`claude-replay-turn-resolution.ts`) finishes the job.
  return { state: 'admitted' }
}
