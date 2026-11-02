import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { StructuredAgentSessionQueuedMessageDrain } from './structured-agent-session-queued-messages'
import {
  deleteQueuedStructuredAgentMessage,
  resumeStructuredAgentQueue,
  sendQueuedStructuredAgentMessage
} from './structured-agent-session-queued-mutations'
import { deferredStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  holdQueuedStructuredAgentMessageEdit,
  republish,
  updateQueuedStructuredAgentMessage
} from './structured-agent-session-queued-edit'
import { moveQueuedStructuredAgentMessage } from './structured-agent-session-queued-move'
import { queuedMailUnavailable } from './structured-agent-session-queued-mail'

/** Read host context lazily during field initialization; session touch renews idle activity. */
export function wireStructuredAgentSessionQueuedMessages(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession> & {
    touch: (sessionId: string) => void
  },
  context: () => StructuredAgentSessionMutationContext
) {
  const drain = new StructuredAgentSessionQueuedMessageDrain({
    sessions,
    getRecord: (sessionId) => context().deps.store.getRecord(sessionId),
    serialize: (sessionId, task) => context().serialize(sessionId, task),
    conversationFence: (sessionId) =>
      structuredAgentSessionConversationFence(context().deps.store, sessionId),
    currentWork: (sessionId) =>
      hostStructuredAgentSessionCurrentWork({ store: context().deps.store, sessions }, sessionId),
    wakeDelivery: (sessionId) => context().wakeDelivery(sessionId),
    submissionReceipt: (sessionId) => context().deps.store.submissionReceipt(sessionId),
    owed: (sessionId, from) => context().deps.queuedAgentMessageOwed?.(sessionId, from) ?? 'owed',
    logger: deferredStructuredAgentSessionLogger(() => context().deps.logger)
  })
  /** Publish the queue again and look for work: what it can hand over may have changed with no write. */
  const refresh = (sessionId: string) => {
    const journal = sessions.get(sessionId)?.journal
    if (journal) {
      void context()
        .serialize(sessionId, async () => republish(context(), sessionId, journal))
        .catch(() => {})
    }
    drain.schedule(sessionId)
  }
  return {
    drain,
    refresh,
    onOpened: (sessionId: string) => {
      const journal = sessions.get(sessionId)?.journal
      if (journal) {
        // Installed before anything reads the next card, so every reader applies the one mail rule.
        journal.queuedMessages.mailUnavailable = (card) =>
          queuedMailUnavailable(context().deps, sessionId)(card)
      }
      journal?.queuedMessages.editLeases.onDeadline(() => {
        void context()
          .serialize(sessionId, async () => {
            if (sessions.get(sessionId)?.journal === journal) {
              republish(context(), sessionId, journal)
            }
          })
          .catch((error: unknown) =>
            context().deps.logger.warn('expiring a queued edit hold failed', {
              scope: 'queued-edit-hold',
              sessionId,
              error
            })
          )
      })
      drain.schedule(sessionId)
    },
    queuedMessageUpdate: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof updateQueuedStructuredAgentMessage>[2]
    ) => updateQueuedStructuredAgentMessage(context(), caller, params),
    queuedMessageEditHold: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof holdQueuedStructuredAgentMessageEdit>[2]
    ) => holdQueuedStructuredAgentMessageEdit(context(), caller, params),
    /** Generation ends wake drain without renewing idle activity. */
    onJournalActivity: (sessionId: string, activity = true) => {
      if (activity) {
        sessions.touch(sessionId)
      }
      drain.schedule(sessionId)
    },
    queuedMessageSend: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof sendQueuedStructuredAgentMessage>[2]
    ) => sendQueuedStructuredAgentMessage(context(), caller, params),
    queuedMessageDelete: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof deleteQueuedStructuredAgentMessage>[2]
    ) => deleteQueuedStructuredAgentMessage(context(), caller, params),
    queuedMessageMove: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof moveQueuedStructuredAgentMessage>[2]
    ) => moveQueuedStructuredAgentMessage(context(), caller, params),
    queuedMessagesResume: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof resumeStructuredAgentQueue>[2]
    ) => resumeStructuredAgentQueue(context(), caller, params)
  }
}
