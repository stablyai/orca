import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type {
  ConnectorConversation,
  ConnectorEvent,
  ConnectorReplyRequest,
  ConnectorReplyResponse
} from '@orca-cloud/connector-contract'
import { every } from './connector-background.js'
import type { ConnectorAdapter, ConnectorSource, InboundMessage } from './connector-adapter.js'
import type { ConnectorInbox, ExpiredThread } from './connector-inbox.js'
import { conversationOf } from './connector-threads.js'
import { routeMessage } from './conversation-routing.js'
import { HeldStarts } from './held-starts.js'
import { PostWorker } from './post-worker.js'
import { answerPromptCard, type CardPress, type PressReply } from './prompt-cards.js'
import type { QueueInTransaction } from './queue-delivery.js'
import { ThreadPosts } from './thread-posts.js'

const POST_INTERVAL_MS = 1_000
const RETENTION_INTERVAL_MS = 60_000
const SEEN_RETENTION_MS = 7 * 24 * 60 * 60_000
const CONTEXT_RETENTION_MS = 24 * 60 * 60_000
// As long as a source's own retries and the inbox's settled rows: a post id that outlives them
// keeps a retried reply from posting twice.
const POST_RETENTION_MS = 7 * 24 * 60 * 60_000

export type ConnectorCore = ReturnType<typeof createConnectorCore>

// What every source shares: routing, the thread-post model and its outbox, held starts and owner
// answers. Each source's adapter brings its ingress, formats and API.
export function createConnectorCore(deps: {
  database: CloudDatabase
  inbox: ConnectorInbox
  queue: QueueInTransaction
  now: () => number
  adapters: ConnectorAdapter[]
}) {
  const { database, inbox, queue, now } = deps
  const sources = deps.adapters.map((adapter) => {
    const threadPosts = new ThreadPosts(database, now, adapter)
    return {
      threadPosts,
      worker: new PostWorker(threadPosts.posts, adapter),
      heldStarts: new HeldStarts({ database, inbox, adapter, now })
    }
  })
  const threadPostsFor = (source: ConnectorSource) =>
    sources.find((entry) => entry.threadPosts.adapter.source === source)?.threadPosts
  // Only an adapter's own ingress calls in with its source.
  const ownThreadPosts = (source: ConnectorSource) => {
    const threadPosts = threadPostsFor(source)
    if (!threadPosts) {
      throw new Error(`no adapter for ${source}`)
    }
    return threadPosts
  }
  const refresh = async (
    transaction: CloudDatabase,
    hostId: string,
    conversations: ConnectorConversation[]
  ) => {
    const unique = new Map(
      conversations.map((conversation) => [
        `${conversation.source}\0${conversation.externalId}`,
        conversation
      ])
    )
    for (const { source, externalId } of unique.values()) {
      await threadPostsFor(source)?.refresh(transaction, hostId, externalId)
    }
  }

  const routeIn = (transaction: CloudDatabase, message: InboundMessage) =>
    routeMessage({ queue, threadPosts: ownThreadPosts(message.source), now }, transaction, message)

  return {
    route: (message: InboundMessage) =>
      database.transaction((transaction) => routeIn(transaction, message)),
    // Inside a caller's transaction, so a source can commit its own progress with the routing.
    routeIn,
    answerCard: (source: ConnectorSource, press: CardPress) =>
      answerPromptCard({ database, queue, threadPosts: ownThreadPosts(source) }, press),
    // A press reply, for sources whose interactions can't answer it directly.
    notify: (source: ConnectorSource, reply: PressReply) =>
      database.transaction((transaction) =>
        ownThreadPosts(source).notify(transaction, reply.target, reply.postId, reply.notice)
      ),
    // The agent's own reply; null when the conversation isn't this host's.
    reply: async (
      hostId: string,
      request: ConnectorReplyRequest
    ): Promise<ConnectorReplyResponse | null> => {
      const { replyId, conversation, turnId, text } = request
      const threadPosts = threadPostsFor(conversation.source)
      const sent =
        threadPosts &&
        (await database.transaction((transaction) =>
          threadPosts.queueAgentReply(transaction, hostId, {
            replyId,
            externalId: conversation.externalId,
            turnId,
            text
          })
        ))
      if (!sent) {
        return null
      }
      return sent.state === 'posted' && sent.messageRef !== null
        ? { status: 'posted', messageId: sent.messageRef }
        : { status: 'queued' }
    },
    // In the transaction that applied a machine's events batch; posts go out on the next pass.
    onEvents: async (transaction: CloudDatabase, hostId: string, events: ConnectorEvent[]) => {
      const conversations = events.flatMap((event) =>
        event.kind === 'snapshot'
          ? event.conversations.map((entry) => entry.conversation)
          : [event.conversation]
      )
      // A snapshot also changes the threads it doesn't list (unverifiable turn, no prompt).
      const unlisted = events.some((event) => event.kind === 'snapshot')
        ? await transaction.query(
            'SELECT source, external_id FROM connector_threads WHERE host_id = ?',
            [hostId]
          )
        : []
      await refresh(transaction, hostId, [...conversations, ...unlisted.map(conversationOf)])
      for (const event of events) {
        if (event.kind === 'turn-ended' && event.lastAssistantMessage !== undefined) {
          await threadPostsFor(event.conversation.source)?.queueTurnFallback(transaction, hostId, {
            externalId: event.conversation.externalId,
            turnId: event.turnId,
            lastAssistantMessage: event.lastAssistantMessage
          })
        }
      }
    },
    // In the transaction that recorded a machine's confirmations.
    onAcks: async (transaction: CloudDatabase, hostId: string, deliveryIds: string[]) => {
      const rows = await transaction.query(
        `SELECT DISTINCT source, external_id FROM connector_inbox
         WHERE host_id = ? AND delivery_id IN (${deliveryIds.map(() => '?').join(', ')})`,
        [hostId, ...deliveryIds]
      )
      await refresh(transaction, hostId, rows.map(conversationOf))
    },
    // In the expiry sweep's transaction, with the threads it hit.
    onExpired: async (transaction: CloudDatabase, threads: ExpiredThread[]) => {
      for (const { hostId, conversation } of threads) {
        await threadPostsFor(conversation.source)?.refresh(
          transaction,
          hostId,
          conversation.externalId
        )
      }
    },
    sendDue: async () => {
      for (const { worker } of sources) {
        await worker.sendDue()
      }
    },
    buildHeldStarts: async () => {
      for (const { heldStarts } of sources) {
        await heldStarts.buildDue()
      }
    },
    startBackground: (): (() => void) => {
      const stops = [
        ...sources.flatMap(({ threadPosts, worker, heldStarts }) => [
          every(`${threadPosts.adapter.source}_posts`, POST_INTERVAL_MS, () => worker.sendDue()),
          every(`${threadPosts.adapter.source}_thread_starts`, POST_INTERVAL_MS, () =>
            heldStarts.buildDue()
          )
        ]),
        every('thread_retention', RETENTION_INTERVAL_MS, async () => {
          await database.query('DELETE FROM connector_seen WHERE seen_at < ?', [
            now() - SEEN_RETENTION_MS
          ])
          await database.query('DELETE FROM connector_thread_context WHERE created_at < ?', [
            now() - CONTEXT_RETENTION_MS
          ])
          for (const { threadPosts } of sources) {
            await threadPosts.posts.pruneFinished(POST_RETENTION_MS)
          }
        })
      ]
      return () => {
        for (const stop of stops) {
          stop()
        }
      }
    }
  }
}
