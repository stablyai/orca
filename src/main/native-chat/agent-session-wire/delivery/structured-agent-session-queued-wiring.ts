import type { StructuredAgentSessionMutationContext } from '../operations/structured-agent-session-mutation-context'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from '../host/structured-agent-session-provider-child'
import { captureHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import { StructuredAgentSessionQueuedMessageDrain } from './structured-agent-session-queued-messages'
import {
  deleteQueuedStructuredAgentMessage,
  resumeStructuredAgentQueue,
  sendQueuedStructuredAgentMessage
} from './structured-agent-session-queued-mutations'
import { deferredStructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import {
  holdQueuedStructuredAgentMessageEdit,
  republish,
  updateQueuedStructuredAgentMessage
} from './structured-agent-session-queued-edit'
import { moveQueuedStructuredAgentMessage } from './structured-agent-session-queued-move'

/** Read host context lazily during field initialization; session touch renews idle activity. */
export function wireStructuredAgentSessionQueuedMessages(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession> & {
    touch: (sessionId: string) => void
  },
  context: () => StructuredAgentSessionMutationContext
) {
  const drain = new StructuredAgentSessionQueuedMessageDrain({
    sessions,
    serialize: (sessionId, task) => context().serialize(sessionId, task),
    conversationFence: (sessionId) =>
      structuredAgentSessionConversationFence(context().deps.store, sessionId),
    wakeDelivery: (sessionId) => context().wakeDelivery(sessionId),
    captureSelection: async (sessionId, journal) => {
      const ctx = context()
      const stopping = await ctx.readStopping(sessionId)
      const child = sessions.get(sessionId)?.child
      const record = ctx.deps.store.getRecord(sessionId)
      return {
        authority: captureHostStructuredAgentSessionWork(
          { store: ctx.deps.store, sessions },
          sessionId,
          journal
        ),
        child: child
          ? {
              fence: child.fence,
              acquisitionGeneration: child.generation,
              ready: child.phase === 'ready',
              closing: !!child.close,
              stopping
            }
          : null,
        steering:
          record?.provider !== 'codex'
            ? { kind: 'other' }
            : child
              ? (ctx.deps.adapter.captureMessageSteeringInputs?.({
                  sessionId,
                  fence: child.fence,
                  acquisitionGeneration: child.generation
                }) ?? { kind: 'codex-unavailable' })
              : { kind: 'codex-unavailable' }
      }
    },
    submissionReceipt: (sessionId) => context().deps.store.submissionReceipt(sessionId),
    owed: (sessionId, from) => context().deps.queuedAgentMessageOwed?.(sessionId, from) ?? 'owed',
    logger: deferredStructuredAgentSessionLogger(() => context().deps.logger)
  })
  /** Sessions with a republish waiting in their lane: more wakes before it runs add nothing. */
  const republishing = new Set<string>()
  /** Publish the queue again and look for work: what it can hand over may have changed with no write. */
  const refresh = (sessionId: string) => {
    if (sessions.get(sessionId)?.journal && !republishing.has(sessionId)) {
      republishing.add(sessionId)
      void context()
        .serialize(sessionId, async () => {
          // Off before publishing: a wake during it queues one more, so none is lost.
          republishing.delete(sessionId)
          const journal = sessions.get(sessionId)?.journal
          if (journal) {
            republish(context(), sessionId, journal)
          }
        })
        .catch(() => republishing.delete(sessionId))
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
        journal.queuedMessages.mailOwed = (source) =>
          context().deps.queuedAgentMessageOwed?.(sessionId, source) ?? 'owed'
      }
      journal?.queuedMessages.editLeases.onDeadline(() => {
        void context()
          .serialize(sessionId, async () => {
            if (sessions.get(sessionId)?.journal === journal) {
              await journal.queuedMessages.editLeases.expire()
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
    onJournalActivity: (sessionId: string, activity = true, inputChanged = true) => {
      if (activity) {
        sessions.touch(sessionId)
      }
      if (inputChanged) {
        drain.schedule(sessionId)
      }
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
