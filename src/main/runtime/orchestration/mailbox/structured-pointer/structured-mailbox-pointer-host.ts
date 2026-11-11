/** Adapt host reads/sends for the pure structured-pointer policy; do not decide delivery here. */

import '../../../../native-chat/agent-session-wire/operations/structured-agent-session-mutation-admission'
import { AGENT_SESSION_NOT_ATTACHED } from '../../../../native-chat/agent-session-wire/operations/structured-agent-session-mutation-refusals'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-host-contract'
import type { StructuredSendAnswer as StructuredMailSendState } from '../../../../native-chat/agent-session-wire/delivery/structured-agent-session-queued-send-answer'
import { structuredAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
import type { StructuredSessionGateFacts } from './structured-session-pointer-delivery'
import {
  sendAgentTurn,
  type StructuredSessionTurnOutcome
} from '../../turn-delivery/send-agent-turn'
import { subscribeForRedrive } from './structured-session-journal-redrive'
import type { JournalPublication } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-conversations'
import { readAgentJournalTurn } from '../../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../../../shared/agent-session/agent-session-context-clear'

/** Names the dispatch a nudge belongs to on the operation row it writes. */
export function structuredPointerCallerKey(dispatchId: string): string {
  return `trusted-local:orchestration:${dispatchId}`
}

/** Scope direct mail by session; preserve existing Dispatch key shape so in-flight nudges still replay. */
export function structuredSessionPointerCallerKey(sessionId: string): string {
  return `trusted-local:orchestration:session:${sessionId}`
}

/** Current-work selects the live turn and actionable prompts in one reader snapshot. */
export async function readStructuredSessionGateFacts(
  sessionId: string
): Promise<StructuredSessionGateFacts | null> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  try {
    const work = await host.currentWorkAtRest(sessionId)
    return work
      ? { turnRunning: work.activeTurnId() !== null, awaitingHuman: work.hasActionablePrompt() }
      : null
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
    async observeMail(attempt) {
      const host = getStructuredAgentSessionHost()
      try {
        if (host) {
          return await host.mailObservation(attempt)
        }
      } catch {
        // An unreadable source never proves acceptance or a person's deletion.
      }
      return { epoch: '', state: { kind: 'unreadable' }, body: null, withdrawal: 'unknown' }
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
        return { kind: 'unreadable' }
      }
      const fence = host.deps.store.getConversation(sessionId)?.currentFence
      if (fence === undefined) {
        return { kind: 'unreadable' }
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
      if (!result?.ok) {
        return { kind: 'unreadable' }
      }
      // A no-op may have lost to handoff; only the host's send answer can settle that attempt.
      return result.value.deleted ? { kind: 'withdrawn' } : observeMailSend(sessionId, operationId)
    },

    watchJournal(sessionId, onActivity) {
      const host = getStructuredAgentSessionHost()
      let source: object | null = null
      // Only what mail waits on: a card handed over, deleted or edited (each moves the queue's
      // revision without adding a card, so a new card, the lane's own included, changes nothing),
      // handoffs settling, an accepted turn, a /clear, a new item. A streamed token changes none.
      const relevant = (publication: JournalPublication) => {
        const replaced = publication.source !== source
        source = publication.source
        const commit = publication.commit
        if (!commit) {
          return replaced && source !== null
        }
        const cards = commit.publication?.cards ?? []
        const inserted = new Set(commit.publication?.insertedCardIds)
        const changedInput =
          commit.inputChanged &&
          (cards.length === 0 || cards.some((card) => !inserted.has(card.messageId)))
        return (
          replaced ||
          changedInput ||
          commit.publication?.items.some(
            (item) => readAgentJournalTurn(item.body) || isAgentSessionContextClear(item.body)
          ) === true ||
          commit.items.some((item) => item.deleted) ||
          (commit.publication?.insertedItemIds?.length ?? 0) > 0
        )
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
