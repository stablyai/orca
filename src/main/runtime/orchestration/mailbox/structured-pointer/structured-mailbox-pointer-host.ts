/** Adapt host reads/sends for the pure structured-pointer policy; do not decide delivery here. */

import '../../../../native-chat/agent-session-wire/operations/structured-agent-session-mutation-admission'
import { AGENT_SESSION_NOT_ATTACHED } from '../../../../native-chat/agent-session-wire/operations/structured-agent-session-mutation-refusals'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-host-contract'
import type { StructuredSendAnswer as StructuredMailSendState } from '../../../../native-chat/agent-session-wire/delivery/structured-agent-session-queued-send-answer'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
import {
  structuredSessionGateFacts,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'
import {
  sendAgentTurn,
  type StructuredSessionTurnOutcome
} from '../../turn-delivery/send-agent-turn'
import { subscribeForRedrive } from './structured-session-journal-redrive'
import type { AgentSessionJournal } from '../../../../native-chat/agent-session-journal/journal-store'

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
    return await host.journalCurrentRead(sessionId)
  } catch (error) {
    // Not attached is a retain reason, not a failure; anything else is still unreadable.
    if ((error as Error)?.message !== AGENT_SESSION_NOT_ATTACHED.code) {
      console.warn('[orchestration] structured journal unreadable', sessionId, error)
    }
    return null
  }
}

/** The host that admitted the send answers for it; this lane only acts on that answer. */
async function observeMailSend(
  sessionId: string,
  operationId: string
): Promise<StructuredMailSendState> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return { kind: 'unreadable' }
  }
  try {
    return await host.sendAnswer(sessionId, operationId)
  } catch {
    // Unreadable proves nothing, least of all that nothing was sent.
    return { kind: 'unreadable' }
  }
}

export function createStructuredMailboxPointerHost(): StructuredMailboxPointerHost {
  return {
    observe(sessionId, operationId) {
      return observeMailSend(sessionId, operationId)
    },

    wakeQueue(sessionId) {
      getStructuredAgentSessionHost()?.wakeQueuedMessages(sessionId)
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
      let seen: string | undefined
      // Only what mail waits on: a card handed over, deleted or edited (each moves the queue's
      // revision without adding a card, so a new card, the lane's own included, changes nothing),
      // handoffs settling, an accepted turn, a /clear, a new item. A streamed token changes none.
      const relevant = (journal: AgentSessionJournal) => {
        const order = journal.inputOrder
        const state = journal.queuedMessages.inputState()
        const cleared = state.queuePauseMarks.cleared?.sequence
        const changes = state.queue.revision - state.queue.cards.size
        const key = `${state.epoch}:${changes}:${order.unsettledSubmissions().length}:${order.links.version()}:${order.links.acceptedHandover()}:${cleared}:${state.items.size}`
        const changed = key !== seen
        seen = key
        return changed
      }
      return host ? subscribeForRedrive(host, sessionId, onActivity, relevant) : () => {}
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
