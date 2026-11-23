import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
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

type WaitingCards = { person: boolean; other: boolean }
const waitingByRevision = new WeakMap<
  SqlAgentSessionJournal,
  { revision: string; waiting: WaitingCards }
>()

/** Whose cards wait, the person's or anyone else's; re-listed only when the queue changes. */
async function waitingCards(journal: SqlAgentSessionJournal): Promise<WaitingCards> {
  const revision = journal.queuedMessages.revision()
  const known = waitingByRevision.get(journal)
  if (known?.revision === revision) {
    return known.waiting
  }
  const waiting = { person: false, other: false }
  for (const card of await journal.queuedMessages.list()) {
    if (card.state === 'waiting' || card.state === 'returned') {
      waiting[card.body.from === undefined ? 'person' : 'other'] = true
    }
  }
  waitingByRevision.set(journal, { revision, waiting })
  return waiting
}

/** Read host context lazily during field initialization; session touch renews idle activity. */
export function wireStructuredAgentSessionQueuedMessages(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession> & {
    touch: (sessionId: string) => void
  },
  context: () => StructuredAgentSessionMutationContext
) {
  const drain = new StructuredAgentSessionQueuedMessageDrain({
    sessions,
    assertQueuedMessageAllowed: (sessionId, messageId) =>
      context().deps.assertQueuedMessageAllowed?.(sessionId, messageId),
    getRecord: (sessionId) => context().deps.store.getRecord(sessionId),
    serialize: (sessionId, task) => context().serialize(sessionId, task),
    conversationFence: (sessionId) =>
      structuredAgentSessionConversationFence(context().deps.store, sessionId),
    wakeDelivery: (sessionId) => context().wakeDelivery(sessionId),
    // An untouched hold over only the person's cards leaves nothing a selection could take.
    idle: async (sessionId, journal) => {
      if (context().accountMoveHeld?.(sessionId) !== true) {
        return false
      }
      const waiting = await waitingCards(journal)
      return waiting.person && !waiting.other
    },
    captureSelection: async (sessionId, journal) => {
      const ctx = context()
      const stopping = await ctx.readStopping(sessionId)
      const child = sessions.get(sessionId)?.child
      const record = ctx.deps.store.getRecord(sessionId)
      // Only a waiting card from the person needs the account a start would use; with none, a
      // hold has nothing left to keep.
      const transition = (await waitingCards(journal)).person
        ? await ctx.accountTransition?.(sessionId)
        : (ctx.accountMoveSettled?.(sessionId) ?? null)
      return {
        ...(transition ? { awaitsAccountMove: true as const } : {}),
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
              : { kind: 'codex-unavailable' },
        // A provider that takes input mid-turn only by cancelling its prompt gets mail after the turn.
        mailJoinsTurn:
          !record || ctx.deps.agents.capabilities(record.provider)?.steering !== 'queue'
      }
    },
    submissionReceipt: (sessionId) => context().deps.store.submissionReceipt(sessionId),
    queuedAgentMessageOwed: (sessionId, from) =>
      context().deps.queuedAgentMessageOwed?.(sessionId, from) ?? 'owed',
    onMessageAdmitted: (message) => context().deps.onMessageAdmitted?.(message),
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
    accountMoveEvidence: (sessionId: string) => {
      context().accountMoveEvidence?.(sessionId)
      drain.schedule(sessionId)
    },
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
