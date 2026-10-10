// Host wiring for mid-turn queueing: builds the serialized drain from the
// host's mutation context and exposes the draft actions (Send, Delete, Resume, Edit), so the host
// class stays a description of its surface.

import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
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

/** `sessions` are the live conversations (their `touch` is the idle sweep's activity renewal,
 *  which the drain's schedule rides); everything else comes from the host's mutation context,
 *  read lazily because the host's fields are still initializing when this is built. */
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
    wakeDelivery: (sessionId) => context().wakeDelivery(sessionId),
    // Read lazily, like the rest of this wiring: the host's deps are not assigned yet.
    logger: deferredStructuredAgentSessionLogger(() => context().deps.logger)
  })
  return {
    drain,
    /** A conversation (re)opened: its edit leases wake the queue when a deadline passes. */
    onOpened: (sessionId: string) => {
      const journal = sessions.get(sessionId)?.journal
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
    /** Every journal publish: turn, submission, prompt, command and Stop
     *  settlements are all commits, and each re-derives the drain's gates. */
    onJournalActivity: (sessionId: string) => {
      sessions.touch(sessionId)
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
    queuedMessagesResume: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof resumeStructuredAgentQueue>[2]
    ) => resumeStructuredAgentQueue(context(), caller, params)
  }
}
