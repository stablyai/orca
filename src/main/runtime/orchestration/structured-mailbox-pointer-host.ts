/** Adapt host reads/sends for the pure structured-pointer policy; do not decide delivery here. */

import { AGENT_SESSION_NOT_ATTACHED } from '../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type {
  StructuredMailboxPointerHost,
  StructuredMailSendState
} from './structured-mailbox-pointer-host-contract'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendSubmission } from '../../../shared/agent-session/agent-session-wire'
import { dispatchWasWithdrawn } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
import {
  structuredSessionGateFacts,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'
import { sendAgentTurn, type StructuredSessionTurnOutcome } from './send-agent-turn'
import { subscribeForRedrive } from './structured-session-journal-redrive'

/** Names the dispatch a nudge belongs to on the operation row it writes. */
export function structuredPointerCallerKey(dispatchId: string): string {
  return `trusted-local:orchestration:${dispatchId}`
}

/** Scope direct mail by session; preserve existing Dispatch key shape so in-flight nudges still replay. */
export function structuredSessionPointerCallerKey(sessionId: string): string {
  return `trusted-local:orchestration:session:${sessionId}`
}

/** Use the full reduced timeline: a busy turn's revised lifecycle item can lie outside any tail page. */
export async function readStructuredSessionGateFacts(
  sessionId: string
): Promise<StructuredSessionGateFacts | null> {
  const snapshot = await readSessionJournal(sessionId)
  if (!snapshot) {
    return null
  }
  // The host's projection of current work: an agent that ended is idle, whatever its rows say.
  const work = getStructuredAgentSessionHost()?.currentWork(sessionId)
  return structuredSessionGateFacts(snapshot.items, work?.scope)
}

async function readSessionJournal(sessionId: string): Promise<AgentJournalSnapshot | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    // Opens a conversation the idle sweep closed; that starts no agent.
    return await host.journalSnapshot(sessionId)
  } catch (error) {
    // Not attached is a retain reason, not a failure; anything else is still unreadable.
    if ((error as Error)?.message !== AGENT_SESSION_NOT_ATTACHED.code) {
      console.warn('[orchestration] structured journal unreadable', sessionId, error)
    }
    return null
  }
}

/** A card's own state, or the handoff it became; a send made at once is its own submission.
 *  Read by key: a lane following many sends never takes a whole-history snapshot for each. */
async function observeMailSend(
  sessionId: string,
  operationId: string
): Promise<StructuredMailSendState> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return { kind: 'unreadable' }
  }
  let facts: Awaited<ReturnType<typeof host.sendFacts>>
  try {
    facts = await host.sendFacts(sessionId, operationId)
  } catch {
    // Unreadable proves nothing, least of all that nothing was sent.
    return { kind: 'unreadable' }
  }
  const { answer } = facts
  if (!answer) {
    return { kind: 'absent' }
  }
  if ('queued' in answer && answer.queued) {
    return answer.queued.state === 'withdrawn' ? { kind: 'withdrawn' } : { kind: 'waiting' }
  }
  const submission = agentSessionSendSubmission(answer)
  switch (submission?.dispatchState) {
    case 'accepted':
      return { kind: 'accepted' }
    case 'pending':
      return { kind: 'waiting' }
    case 'rejected': {
      if (submission.queuedMessageId !== undefined) {
        // A card's failed handoff: the card is the queue's to retry, never a mailbox copy.
        return { kind: 'waiting' }
      }
      const at = facts.rejectedAt
      return {
        kind: 'rejected',
        cancelled: dispatchWasWithdrawn(submission),
        // Journal order, never clocks: only a turn handed over, or a clear made, after the rejection settled.
        recovered: at !== undefined && (facts.acceptedTurnAt > at || facts.clearedAt > at)
      }
    }
    default:
      return { kind: 'unknown' }
  }
}

export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  return {
    observe(sessionId, operationId) {
      return observeMailSend(sessionId, operationId)
    },

    async withdraw(sessionId, operationId) {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return false
      }
      const fence = host.deps.store.getConversation(sessionId)?.currentFence
      if (fence === undefined) {
        // No conversation is left to hand the card over.
        return true
      }
      const fields = { messageId: operationId }
      const result = await host
        .queuedMessageDelete(
          { callerKey: structuredSessionPointerCallerKey(sessionId) },
          {
            envelope: {
              sessionId,
              clientOperationId: mintAgentSessionOperationId(Date.now()),
              expectedRuntimeFence: fence,
              payloadFingerprint: structuredAgentSessionPayloadFingerprint({
                method: 'agentSession.queuedMessageDelete',
                sessionId,
                fields
              })
            },
            ...fields
          }
        )
        .catch(() => null)
      // Already handed over, or never a card (sent at once), counts as done: nothing is left to hand over twice.
      return result?.ok === true
    },

    watchJournal(sessionId, onActivity) {
      const host = getStructuredAgentSessionHost()
      return host ? subscribeForRedrive(host, sessionId, onActivity) : () => {}
    },

    currentFence(sessionId) {
      return (
        getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.currentFence ?? null
      )
    },

    async send(input) {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return { kind: 'unattached' }
      }
      let outcome: StructuredSessionTurnOutcome
      try {
        outcome = await sendAgentTurn({
          kind: 'structured-session',
          host,
          sessionId: input.sessionId,
          callerKey: input.dispatchId
            ? structuredPointerCallerKey(input.dispatchId)
            : structuredSessionPointerCallerKey(input.sessionId),
          turn: {
            body: input.body,
            // A person's message: queued behind running work or a question, one handed over per turn.
            delivery: 'queue',
            operationId: input.operationId,
            expectedRuntimeFence: input.expectedRuntimeFence,
            beforeRun: () => {
              if (!input.stillOwed()) {
                throw new StructuredMailObsoleteError()
              }
            }
          }
        })
      } catch (error) {
        if (error instanceof StructuredMailObsoleteError) {
          return { kind: 'obsolete' }
        }
        throw error
      }
      switch (outcome.kind) {
        case 'refused':
          return outcome.refusal.code === AGENT_SESSION_NOT_ATTACHED.code
            ? { kind: 'unattached' }
            : { kind: 'refused' }
        case 'queued':
          return { kind: 'queued' }
        case 'sent':
          return { kind: 'sent', state: outcome.submission?.dispatchState ?? 'unknown' }
      }
    }
  }
}

class StructuredMailObsoleteError extends Error {}
