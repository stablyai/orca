/**
 * The structured-session half of the structured pointer lane.
 *
 * Keeps every `getStructuredAgentSessionHost()` call in one place so the delivery policy above it
 * stays pure and testable. Nothing here decides whether to deliver; it only performs the read and
 * the send and reports what the host said.
 */

import { AGENT_SESSION_NOT_ATTACHED } from '../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type {
  StructuredMailboxPointerHost,
  StructuredPointerSessionFacts
} from './structured-mailbox-pointer-delivery'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import {
  structuredSessionGateFacts,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'
import { sendAgentTurn } from './send-agent-turn'

/** Names the dispatch a nudge belongs to on the operation row it writes. */
export function structuredPointerCallerKey(dispatchId: string): string {
  return `trusted-local:orchestration:${dispatchId}`
}

/**
 * The caller key for direct peer mail, which is addressed to the worker's own handle and has no
 * dispatch to name.
 *
 * A separate key rather than a reshaped one: the ledger is keyed on (callerKey, operationId), so
 * changing the dispatch key's shape would orphan every nudge already in flight under the old one.
 */
export function structuredSessionPointerCallerKey(sessionId: string): string {
  return `trusted-local:orchestration:session:${sessionId}`
}

/**
 * Whether a structured session is idle, for group addressing (`@idle`), read off its FULL reduced
 * timeline.
 *
 * Never a bounded page. A settled turn's lifecycle item is revised in place, so on any tail window
 * an idle session and a busy one whose lifecycle item scrolled off look identical — and
 * idle-with-history is the normal steady state of a working agent.
 */
export async function readStructuredSessionGateFacts(
  sessionId: string
): Promise<StructuredSessionGateFacts | null> {
  const snapshot = await readSessionJournal(sessionId)
  return snapshot ? structuredSessionGateFacts(snapshot.items) : null
}

/** What each recorded send settled as. */
async function readPointerSessionFacts(
  sessionId: string
): Promise<StructuredPointerSessionFacts | null> {
  const snapshot = await readSessionJournal(sessionId)
  if (!snapshot) {
    return null
  }
  const boundary =
    getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)?.providerContextBoundary
  return {
    submissions: boundary
      ? snapshot.submissions.filter((submission) => submission.fence > boundary.afterFence)
      : snapshot.submissions
  }
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

export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  return {
    readSessionFacts(sessionId) {
      return readPointerSessionFacts(sessionId)
    },

    currentFence(sessionId) {
      return (
        getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? null
      )
    },

    currentContextClearOperationId(sessionId) {
      return getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)
        ?.providerContextBoundary?.operationId
    },

    async send(input) {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return { kind: 'unattached' }
      }
      const outcome = await sendAgentTurn({
        kind: 'structured-session',
        host,
        sessionId: input.sessionId,
        callerKey: input.dispatchId
          ? structuredPointerCallerKey(input.dispatchId)
          : structuredSessionPointerCallerKey(input.sessionId),
        turn: {
          body: input.body,
          // As a person's message is: a busy chat queues it as a card, sent when the turn ends.
          delivery: 'queue',
          operationId: input.operationId,
          expectedRuntimeFence: input.expectedRuntimeFence
        }
      })
      switch (outcome.kind) {
        case 'refused':
          return outcome.refusal.code === AGENT_SESSION_NOT_ATTACHED.code
            ? { kind: 'unattached' }
            : { kind: 'sent', state: 'rejected' }
        case 'queued':
          return { kind: 'queued' }
        case 'sent': {
          // `pending` is not yet an acknowledgement; only `accepted` may consume mail. A send still
          // pending after the wait parks for the next journal edge.
          const state = outcome.submission?.dispatchState
          return {
            kind: 'sent',
            state: state === 'accepted' ? 'accepted' : state === 'rejected' ? 'rejected' : 'unknown'
          }
        }
      }
    }
  }
}
