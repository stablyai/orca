import type { CloudDatabase, SqlRow } from '@orca-cloud/cloud-database'
import type { ConnectorConversation, ConnectorHelloRequest } from '@orca-cloud/connector-contract'
import type { ConnectorAdapter, Notice, NoticeTarget, ThreadPlace } from './connector-adapter.js'
import { ConnectorPosts } from './connector-posts.js'
import { conversationKey, threadPlace } from './connector-threads.js'
import { conversationStatus } from './conversation-status.js'
import { knownHost } from './machine-choice.js'
import {
  answerablePrompt,
  answerDeliveryId,
  ownerActionState,
  pendingPrompt
} from './owner-controls.js'
import { refreshPromptCards } from './prompt-cards.js'

// A turn's last message is posted only if the agent hasn't replied itself by then.
const FALLBACK_DELAY_MS = 5_000

type BoundThread = {
  place: ThreadPlace
  hostName: string
  hello: ConnectorHelloRequest | undefined
  row: SqlRow
}

// A thread bound to this host, with its machine's name; null for anyone else's conversation.
async function boundThread(
  transaction: CloudDatabase,
  hostId: string,
  conversation: ConnectorConversation
): Promise<BoundThread | null> {
  const [row] = await transaction.query(
    `SELECT t.*, h.host_name, h.hello FROM connector_threads t
     JOIN connector_hosts h ON h.host_id = t.host_id
     WHERE t.source = ? AND t.external_id = ? AND t.host_id = ?`,
    [...conversationKey(conversation), hostId]
  )
  return row
    ? {
        place: threadPlace(row),
        hostName: String(row.host_name),
        hello: knownHost(row)?.hello,
        row
      }
    : null
}

// The thread-post model for one source: a conversation shows as one status message edited in place,
// a card per answerable prompt, the agent's replies and fallbacks, notices to the writer, and an
// acknowledgement on each message handed toward a machine. Bodies come from the source's adapter.
export class ThreadPosts {
  readonly posts: ConnectorPosts

  constructor(
    database: CloudDatabase,
    now: () => number,
    readonly adapter: ConnectorAdapter
  ) {
    this.posts = new ConnectorPosts(database, now, adapter.source)
  }

  // Serialized per conversation, so a refresh that read older state can't land after a newer one.
  async lockStatus(transaction: CloudDatabase, externalId: string): Promise<void> {
    await transaction.lockQuotaScope(`orca-connector-status:${this.adapter.source}:${externalId}`)
  }

  // The status message is a projection of the thread's current state: refreshing twice is a no-op.
  async refresh(transaction: CloudDatabase, hostId: string, externalId: string): Promise<void> {
    await this.lockStatus(transaction, externalId)
    const conversation = { source: this.adapter.source, externalId }
    const thread = await boundThread(transaction, hostId, conversation)
    if (!thread) {
      return
    }
    const [latest] = await transaction.query(
      `SELECT state, result FROM connector_inbox
       WHERE host_id = ? AND source = ? AND external_id = ? AND kind IN ('start', 'send')
       ORDER BY seq DESC LIMIT 1`,
      [hostId, ...conversationKey(conversation)]
    )
    // The owner's own answer to the shown prompt, matched by its id.
    const shown = pendingPrompt(thread.row)
    const answer = shown
      ? await ownerActionState(transaction, hostId, answerDeliveryId(conversation, shown.promptId))
      : null
    const offered = await refreshPromptCards(
      transaction,
      this,
      { place: thread.place, externalId },
      answerablePrompt(thread.row, thread.hello)
    )
    await this.posts.setStatus(transaction, {
      ...thread.place,
      postId: `status:${externalId}`,
      body: this.adapter.status({
        hostName: thread.hostName,
        ownerUserId: String(thread.row.owner_user_id),
        status: conversationStatus(thread.row, latest, answer, offered)
      })
    })
  }

  // A turn's reply and its fallback decide under one lock, so exactly one of them wins.
  private async lockTurn(transaction: CloudDatabase, turnKey: string): Promise<void> {
    await transaction.lockQuotaScope(`orca-connector-turn:${this.adapter.source}:${turnKey}`)
  }

  // From each turn-ended event itself, so every ended turn gets its own fallback.
  async queueTurnFallback(
    transaction: CloudDatabase,
    hostId: string,
    turn: { externalId: string; turnId: number; lastAssistantMessage: string }
  ): Promise<void> {
    const conversation = { source: this.adapter.source, externalId: turn.externalId }
    const thread = await boundThread(transaction, hostId, conversation)
    if (!thread || turn.lastAssistantMessage.trim().length === 0) {
      return
    }
    const turnKey = `${turn.externalId}:${turn.turnId}`
    await this.lockTurn(transaction, turnKey)
    if (await this.posts.hasReplyForTurn(transaction, turnKey)) {
      return
    }
    await this.posts.queue(transaction, {
      ...thread.place,
      postId: `fallback:${turnKey}`,
      kind: 'message',
      body: this.adapter.agentText(turn.lastAssistantMessage),
      turnKey,
      delayMs: FALLBACK_DELAY_MS
    })
  }

  // The agent's own reply; retries with one replyId post once. Null when the thread isn't this
  // host's.
  async queueAgentReply(
    transaction: CloudDatabase,
    hostId: string,
    reply: { replyId: string; externalId: string; turnId: number; text: string }
  ): Promise<{ state: string; messageRef: string | null } | null> {
    const conversation = { source: this.adapter.source, externalId: reply.externalId }
    const thread = await boundThread(transaction, hostId, conversation)
    if (!thread) {
      return null
    }
    const postId = `reply:${hostId}:${reply.replyId}`
    const turnKey = `${reply.externalId}:${reply.turnId}`
    await this.lockTurn(transaction, turnKey)
    await this.posts.queue(transaction, {
      ...thread.place,
      postId,
      kind: 'message',
      body: this.adapter.agentText(reply.text),
      turnKey
    })
    await this.posts.cancelQueued(transaction, `fallback:${turnKey}`)
    return await this.posts.find(transaction, postId)
  }

  async notify(
    transaction: CloudDatabase,
    target: NoticeTarget,
    postId: string,
    notice: Notice
  ): Promise<void> {
    await this.posts.queue(transaction, {
      ...target.place,
      postId,
      ...this.adapter.notice(target, notice)
    })
  }

  async acknowledge(
    transaction: CloudDatabase,
    place: ThreadPlace,
    messageKey: string,
    messageId: string
  ): Promise<void> {
    await this.posts.queue(transaction, {
      ...place,
      postId: `eyes:${messageKey}`,
      kind: 'reaction',
      body: this.adapter.seen(place, messageId)
    })
  }
}
