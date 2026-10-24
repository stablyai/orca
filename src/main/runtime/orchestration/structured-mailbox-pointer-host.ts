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
import { sendAgentTurn, type StructuredSessionTurnOutcome } from './send-agent-turn'
import { isAdmissibleAgentJournalMessageBody } from '../../../shared/agent-session-journal-schemas'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/structured-agent-session-send-mutation'

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
  if (!snapshot) {
    return null
  }
  // The host's projection of current work: an agent that ended is idle, whatever its rows say.
  const work = getStructuredAgentSessionHost()?.currentWork(sessionId)
  return structuredSessionGateFacts(snapshot.items, work?.scope)
}

/** What each recorded send settled as. */
async function readPointerSessionFacts(
  sessionId: string
): Promise<StructuredPointerSessionFacts | null> {
  const host = getStructuredAgentSessionHost()
  const evidence = await host?.readMailHandoffEvidence(sessionId, '').catch(() => null)
  if (!evidence) {
    return null
  }
  return { epoch: evidence.epoch, frontier: evidence.frontier }
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
    readReceipt(reference) {
      const unreadable = {
        verdict: 'unreadable',
        scope: { kind: 'global' },
        operationId: reference.operationId
      } as const
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return unreadable
      }
      const read = host.deps.store.readCommandReceipt({ kind: 'global' }, reference.operationId)
      if (read.verdict !== 'readable') {
        return read
      }
      const manifest = reference.manifest
      const body: unknown = manifest && JSON.parse(manifest.body)
      const caller = manifest?.dispatchId
        ? structuredPointerCallerKey(manifest.dispatchId)
        : structuredSessionPointerCallerKey(reference.sessionId)
      if (
        manifest &&
        isAdmissibleAgentJournalMessageBody(body) &&
        read.receipt.sessionId === reference.sessionId &&
        read.receipt.method === 'agentSession.send' &&
        read.receipt.callerKey === caller &&
        read.receipt.fingerprint ===
          structuredAgentSessionMessageSendMutation({
            sessionId: reference.sessionId,
            clientOperationId: reference.operationId,
            expectedRuntimeFence: manifest.runtimeFence,
            body
          }).envelope.payloadFingerprint
      ) {
        return read
      }
      return unreadable
    },
    async readHandoffEvidence(reference) {
      return (
        (await getStructuredAgentSessionHost()?.readMailHandoffEvidence(
          reference.sessionId,
          reference.clientMessageId
        )) ?? null
      )
    },

    readHandoffEvidenceNow(reference) {
      return (
        getStructuredAgentSessionHost()?.readMailHandoffEvidenceNow(
          reference.sessionId,
          reference.clientMessageId
        ) ?? null
      )
    },
    readSessionFacts(sessionId) {
      return readPointerSessionFacts(sessionId)
    },

    hasActionablePromptNow(sessionId) {
      return getStructuredAgentSessionHost()?.currentWork(sessionId)?.hasActionablePrompt() ?? null
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
            // A person's plain send: every agent takes it the way it takes their own mid-turn message.
            delivery: 'now',
            operationId: input.operationId,
            expectedRuntimeFence: input.expectedRuntimeFence,
            beforeRun: () => {
              if (!input.beforeRun()) {
                throw new StructuredMailSupersededError()
              }
              if (
                input.body.from?.orchestration?.message === 'mail-notice' &&
                host.currentWork(input.sessionId)?.hasActionablePrompt()
              ) {
                throw new StructuredMailHeldError()
              }
            }
          }
        })
      } catch (error) {
        if (error instanceof StructuredMailSupersededError) {
          return { kind: 'superseded', noEffect: true }
        }
        if (error instanceof StructuredMailHeldError) {
          return { kind: 'held' }
        }
        throw error
      }
      switch (outcome.kind) {
        case 'refused':
          if (
            outcome.refusal.code === 'agent_session_operation_invalid' &&
            outcome.refusal.details?.reason === 'conversationCommandInFlight'
          ) {
            return { kind: 'held' }
          }
          return outcome.refusal.code === AGENT_SESSION_NOT_ATTACHED.code
            ? { kind: 'unattached' }
            : {
                kind: 'sent',
                state: 'rejected',
                ...(outcome.refusal.code === 'agent_session_operation_expired'
                  ? { nonAdmission: 'expired' as const }
                  : {})
              }
        case 'queued':
          return { kind: 'queued', clientMessageId: outcome.clientMessageId }
        case 'sent': {
          // `pending` is not yet an acknowledgement; only `accepted` may consume mail. A send still
          // pending after the wait parks for the next journal edge.
          const state = outcome.submission?.dispatchState
          return {
            kind: 'sent',
            clientMessageId: outcome.submission?.clientMessageId ?? outcome.clientMessageId,
            state: state === 'accepted' ? 'accepted' : state === 'rejected' ? 'rejected' : 'unknown'
          }
        }
      }
    }
  }
}

class StructuredMailHeldError extends Error {}

class StructuredMailSupersededError extends Error {}
