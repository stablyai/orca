/** Adapt host reads/sends for the pure structured-pointer policy; do not decide delivery here. */

import { AGENT_SESSION_NOT_ATTACHED } from '../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type {
  StructuredMailboxPointerHost,
  StructuredMailSendState
} from './structured-mailbox-pointer-host-contract'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
import {
  structuredSessionGateFacts,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'
import { sendAgentTurn, type StructuredSessionTurnOutcome } from './send-agent-turn'
import { sessionCrewChanges } from './crew/crew-changes'
import { structuredMailAfterStop } from './structured-mail-source'
import { subscribeForRedrive } from './structured-session-journal-redrive'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'

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
  const readEligibility = (sessionId: string) => {
    const host = getStructuredAgentSessionHost()
    const state = host?.reads.readQueueStop(sessionId)
    const fence = host?.deps.store.getConversation(sessionId)?.currentFence
    return host && state && fence !== undefined
      ? {
          host,
          fence,
          key: `${state.epoch}:${state.stopSequence}:${state.resumedSequence}:${state.clearedSequence}`,
          stopAt: state.stopAt
        }
      : null
  }
  return {
    attachment: getStructuredAgentSessionHost,
    readEligibility,
    async openEligibility(sessionId) {
      const host = getStructuredAgentSessionHost()
      if (!host || !host.deps.store.getConversation(sessionId)) {
        return null
      }
      try {
        await host.reads.openQueueStop(sessionId)
        return host === getStructuredAgentSessionHost() ? readEligibility(sessionId) : null
      } catch {
        return null
      }
    },
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
      let seen: string | undefined
      // Only what mail waits on: a card handed over, deleted or edited (each moves the queue's
      // revision without adding a card, so a new card, the lane's own included, changes nothing),
      // handoffs settling, an accepted turn, a /clear, a Resume (the person's send writes one, and
      // lifts mail held at their Stop), a new item. A streamed token changes none.
      const relevant = (journal: AgentSessionJournal) => {
        const order = journal.inputOrder
        const state = journal.queuedMessages.inputState()
        const { cleared, resumedSequence, latestStop } = state.queuePauseMarks
        const changes = state.queue.revision - state.queue.cards.size
        const key = `${state.epoch}:${changes}:${order.unsettledSubmissions().length}:${order.links.version()}:${order.links.acceptedHandover()}:${cleared?.sequence}:${resumedSequence}:${latestStop?.sequence}:${state.items.size}`
        const changed = key !== seen
        seen = key
        return changed
      }
      let host = getStructuredAgentSessionHost()
      let stop = host ? subscribeForRedrive(host, sessionId, onActivity, relevant) : () => {}
      const unsubscribe = sessionCrewChanges.subscribe(() => {
        const next = getStructuredAgentSessionHost()
        if (host === next) {
          return
        }
        stop()
        host = next
        seen = undefined
        stop = host ? subscribeForRedrive(host, sessionId, onActivity, relevant) : () => {}
        onActivity()
      })
      return () => {
        unsubscribe()
        stop()
      }
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
            // On the write lane, with the card or turn it admits: a Stop committed meanwhile is seen.
            admit: (stop) => {
              if (!input.stillOwed()) {
                throw new StructuredMailRefusal('obsolete')
              }
              // Only mail written after the Stop wakes the chat; the same second is an order nobody
              // can tell, so it waits too.
              if (!structuredMailAfterStop(input.createdAt, stop?.at ?? null)) {
                throw new StructuredMailRefusal('held')
              }
            }
          }
        })
      } catch (error) {
        if (error instanceof StructuredMailRefusal) {
          return { kind: error.kind }
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

class StructuredMailRefusal extends Error {
  constructor(readonly kind: 'obsolete' | 'held') {
    super(kind)
  }
}
