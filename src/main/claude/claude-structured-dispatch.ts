import { randomUUID } from 'node:crypto'
import { isAbortSignalReason } from '../../shared/abort-signal-reason'
import {
  forgetRetiredWaiter,
  forgetWaiter,
  retireWaiter,
  waitForReplay
} from './claude-structured-dispatch-waiters'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeDispatchWaiter, ClaudeSession } from './claude-structured-session-state'
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
import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import type { AgentJournalDispatchRejection } from '../../shared/agent-session-failure-words'
import {
  claudeUnwrittenUserMessageError,
  claudeUserMessageWasProvablyUnwritten
} from './claude-agent-sdk-user-message-queue'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import { isAgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { ClaudeControlRequestError } from './claude-stream-json-connection'

const MAX_ACTIVE_DISPATCH_WAITERS = 64

export function settleCancelledClaudeDispatchWaiters(
  session: ClaudeSession,
  cancelledUuids: readonly string[],
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  rejectClaudeDispatchWaiters(
    session,
    cancelledUuids,
    agentSessionFailureFact('cancelled'),
    onSettledLate
  )
}

export function rejectClaudeDispatchWaiters(
  session: ClaudeSession,
  uuids: readonly string[],
  fact: SubmissionRejectionFact,
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  const named = new Set(uuids)
  const activeWaiters = session.dispatchWaiters.filter((waiter) => named.has(waiter.sentUuid))
  const retiredWaiters = session.retiredDispatchWaiters.filter((waiter) =>
    named.has(waiter.sentUuid)
  )
  // Release and report each waiter together to preserve host ownership.
  const report = (waiter: ClaudeDispatchWaiter): void => {
    if (waiter.clientMessageId) {
      onSettledLate?.({
        clientMessageId: waiter.clientMessageId,
        state: 'rejected',
        unrun: true,
        ...claudeDispatchRejection(fact)
      })
    }
  }
  for (const waiter of activeWaiters) {
    forgetWaiter(session, waiter)
    waiter.resolve(null)
    report(waiter)
  }
  for (const waiter of retiredWaiters) {
    forgetRetiredWaiter(session, waiter)
    report(waiter)
  }
}

/** Retain uncertain sends for late replay; never resend messages that may already have run. */
export function releaseClaudeDispatchWaitersInDoubt(
  session: ClaudeSession,
  waiters: readonly ClaudeDispatchWaiter[],
  reason: string,
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  for (const waiter of waiters) {
    retireWaiter(session, waiter)
    waiter.resolve(null)
    if (waiter.clientMessageId) {
      onSettledLate?.({ clientMessageId: waiter.clientMessageId, state: 'unknown', reason })
    }
  }
}

/** Retain bounded waiter identities after exit so late replay can still settle delivery. */
export function retireClaudeDispatchWaiters(session: ClaudeSession): void {
  for (const waiter of session.dispatchWaiters.splice(0)) {
    retireWaiter(session, waiter)
    waiter.resolve(null)
  }
}

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
    sentUuid?: string
    signal?: AbortSignal
    admitPreparedInput?: Parameters<
      StructuredAgentSessionAdapter['dispatch']
    >[0]['admitPreparedInput']
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
  // Classify the mapped trailing prompt so command detection matches what Claude receives.
  const acceptsResult = claudeDispatchInvokesSlashCommand(content)
  const sentUuid = input.sentUuid ?? randomUUID()
  const arm = (requestedAt = input.requestedAt) => {
    ++session.dispatchSequence
    // Invalidate context reports requested before this send.
    session.translator?.markContextActivity()
    return waitForReplay(
      session,
      acceptsResult,
      sentUuid,
      claudeDispatchContentKey(content),
      input.clientMessageId ?? null,
      requestedAt ?? null
    )
  }
  const message = {
    type: 'user',
    uuid: sentUuid,
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: session.providerSessionId
  }
  const pending = { replay: beforeDispatch || input.admitPreparedInput ? undefined : arm() }
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
    if (input.admitPreparedInput) {
      await beforeDispatch?.()
      await input.admitPreparedInput(
        (requestedAt) =>
          new Promise<void>((resolve) => {
            if (session.dispatchWaiters.length >= MAX_ACTIVE_DISPATCH_WAITERS) {
              throw claudeUnwrittenUserMessageError(new Error(DISPATCH_REJECTED_QUEUE_FULL))
            }
            pending.replay = arm(requestedAt)
            resolve(session.connection.send(message))
          }),
        () => session.translator?.currentTurnId ?? null
      )
    } else {
      await (authorize
        ? session.connection.send(message, authorize)
        : session.connection.send(message))
    }
  } catch (error) {
    const replay = pending.replay
    if (!replay) {
      // Preserve pre-dispatch aborts for the host's Stop settlement.
      if (
        error instanceof AgentSessionPreDispatchError ||
        isAbortSignalReason(input.signal, error)
      ) {
        throw error
      }
      if (isAgentSessionOptionRejectedError(error)) {
        return {
          state: 'rejected',
          ...claudeDispatchRejection(
            agentSessionFailureFact(
              'providerRejected',
              error.cause instanceof ClaudeControlRequestError
                ? { detail: providerDiagnostic(error.message, 'person') }
                : {}
            )
          )
        }
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
      // Proven unwritten frames are rejected; ambiguous writes remain unknown.
      return { state: 'rejected', ...claudeWriteFailureRejection(error) }
    }
    if (!waiter.retired) {
      retireWaiter(session, waiter)
      waiter.resolve(null)
    }
    return { state: 'unknown', reason: dispatchWriteOutcomeUnknownReason(error) }
  }
  // Admit on write: an echo may wait for the current turn; replay settles delivery later.
  return { state: 'admitted' }
}
