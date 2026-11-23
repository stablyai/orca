// A conversation's delivery to a native chat, and which of the chat's turns were deliveries.
import type {
  ConnectorAsker,
  ConnectorTurnOrigin
} from '../../shared/connectors/connector-cloud-contract'
import type { NativeChatAgent } from '../../shared/agent-launch/permissions/agent-chat-permission-support'
import type {
  ExternalConversationBot,
  ExternalConversationLink
} from '../../shared/connectors/external-conversation-link'
import {
  chatPaneKey,
  deliverToChat,
  watchChatNews,
  type ConversationChatHost
} from './external-conversation-chat'
import { HOST_CLOCK } from './external-conversation-host'
import { answersThroughOutbox } from '../../shared/agent-session/journal/journal-connector-reply'
import type { OutboxDelivery } from './external-conversation-ended-turn'
import type { ConnectorMessage, ConversationKey, Delivery } from './external-conversation-types'

/** A native chat a conversation links to; chats run only on this host. */
export type LinkableChat = {
  worktreeId: string
  sessionId: string
  agent: NativeChatAgent
  bot?: ExternalConversationBot
}

export function chatLink(key: ConversationKey, chat: LinkableChat): ExternalConversationLink {
  const { sessionId, agent, bot } = chat
  return {
    ...key,
    paneKey: chatPaneKey(sessionId),
    sessionId,
    agent,
    ...(bot ? { bot } : {}),
    createdAt: Date.now()
  }
}

export function linkedChat(worktreeId: string, link: ExternalConversationLink): LinkableChat {
  const { sessionId, agent, bot } = link
  return { worktreeId, sessionId, agent, ...(bot ? { bot } : {}) }
}

export class ChatDeliveries {
  // Chats sent a delivery since their last turn ended; that turn is the delivery's, not Orca-typed.
  private readonly delivered = new Set<string>()
  private readonly replyDeliveries = new Map<string, Map<object, OutboxDelivery | null>>()
  // Chats a delivery is being sent to; their turn may start before the send returns.
  private readonly sending = new Map<string, Set<object>>()
  private readonly generations = new Map<string, object>()
  // Deliveries sent to each chat since its last turn ended that no turn has named, with when each was sent.
  private readonly unstarted = new Map<string, { deliveryId: string; sentAt: number }[]>()
  // Each chat's told turn starts (by their start) that no turn end has followed yet, oldest first.
  private readonly openTurns = new Map<string, number[]>()
  private releaseUnwatched: (() => void) | null = null

  constructor(
    private readonly link: (
      key: ConversationKey,
      chat: LinkableChat,
      text: string,
      asker?: ConnectorAsker
    ) => void
  ) {}

  /** A watch gap leaves no proof these deliveries still belong to the current turn. */
  clear(): void {
    this.generations.clear()
    this.sending.clear()
    this.delivered.clear()
    this.replyDeliveries.clear()
    this.unstarted.clear()
    this.openTurns.clear()
  }

  /** Unwatched, a delivered turn keeps its thread until it ends; an end or close no watch hears still ends it. */
  followUnwatched(chats: ConversationChatHost | undefined): void {
    this.stopFollowing()
    if (!chats) {
      this.clear()
      return
    }
    this.releaseUnwatched = watchChatNews(
      chats,
      (news) => {
        if (news.kind !== 'prompt') {
          this.origin(news.sessionId, null)
        }
      },
      'external-conversations-unwatched'
    )
  }

  /** A watch hears turn ends again, or the seam is gone. */
  stopFollowing(): void {
    this.releaseUnwatched?.()
    this.releaseUnwatched = null
  }

  /** A delivery the chat just took, waiting for the turn it starts. */
  admit(sessionId: string, deliveryId: string): { deliveryId: string; sentAt: number } {
    const sent = { deliveryId, sentAt: HOST_CLOCK.now() }
    this.unstarted.set(sessionId, [...(this.unstarted.get(sessionId) ?? []), sent])
    return sent
  }

  /** Whether a delivery the chat took waits for a turn to name it. */
  waiting(sessionId: string): boolean {
    return this.unstarted.has(sessionId)
  }

  /** Whether the chat's current or next turn is a delivery's; read without consuming it. */
  pending(sessionId: string): boolean {
    return this.sending.has(sessionId) || this.delivered.has(sessionId)
  }

  /** Read once per ended turn; `turnAt` is its start, null when it was never told. */
  origin(sessionId: string, turnAt: number | null): ConnectorTurnOrigin {
    // One that came during the turn joined it or waits behind it; which, no one can tell.
    this.unstarted.delete(sessionId)
    // A chat's turns run one at a time: this end closes its own start and any before it, or, its
    // start unknown, the oldest one open.
    const told = this.openTurns.get(sessionId) ?? []
    const open = turnAt === null ? told.slice(1) : told.filter((at) => at > turnAt)
    if (open.length > 0) {
      this.openTurns.set(sessionId, open)
    } else {
      this.openTurns.delete(sessionId)
    }
    this.replyDeliveries.delete(sessionId)
    return this.delivered.delete(sessionId) ? 'delivery' : 'local'
  }

  /** Every tracked delivery must be eligible before journal attribution can prove coverage. */
  outboxDeliveries(sessionId: string): OutboxDelivery[] | null {
    const deliveries = [...(this.replyDeliveries.get(sessionId)?.values() ?? [])]
    return deliveries.length > 0 && deliveries.every((delivery) => delivery !== null)
      ? deliveries
      : null
  }

  private replyWindow(sessionId: string): Map<object, OutboxDelivery | null> {
    const window = this.replyDeliveries.get(sessionId) ?? new Map<object, OutboxDelivery | null>()
    this.replyDeliveries.set(sessionId, window)
    return window
  }

  /**
   * The delivery a turn that began at `turnAt` answers: the one sent by then, taken once. None when
   * several were (it answers them all), or the turn began before any (a message joining it).
   */
  started(sessionId: string, turnAt: number): string | undefined {
    // A start seen before the last turn's end (status rows and turn ends arrive apart) can't tell a
    // message that joined that turn from one that started this: it names none.
    const open = this.openTurns.get(sessionId) ?? []
    if (!open.includes(turnAt)) {
      this.openTurns.set(sessionId, [...open, turnAt])
    }
    if (open.some((at) => at !== turnAt)) {
      this.unstarted.delete(sessionId)
      return undefined
    }
    const waiting = this.unstarted.get(sessionId) ?? []
    const sent = waiting.filter((entry) => entry.sentAt <= turnAt)
    const later = waiting.filter((entry) => entry.sentAt > turnAt)
    if (later.length > 0) {
      this.unstarted.set(sessionId, later)
    } else {
      this.unstarted.delete(sessionId)
    }
    return sent.length === 1 ? sent[0]?.deliveryId : undefined
  }

  /** A chat that already took its message elsewhere (an automation run): its turn is the conversation's. */
  adopt(key: ConversationKey, chat: LinkableChat, text: string): void {
    // Marked first, so the running turn the link joins is the conversation's.
    const window = this.replyWindow(chat.sessionId)
    const attempt = {}
    window.set(attempt, null)
    const wasDelivered = this.delivered.has(chat.sessionId)
    this.delivered.add(chat.sessionId)
    try {
      this.link(key, chat, text)
    } catch (error) {
      window.delete(attempt)
      if (!wasDelivered) {
        this.delivered.delete(chat.sessionId)
      }
      throw error
    }
  }

  /** Linked once the chat takes the message, so a refused one never takes a shared chat's replies. */
  async deliver(
    chats: ConversationChatHost | undefined,
    key: ConversationKey,
    chat: LinkableChat,
    delivery: ConnectorMessage & {
      deliveryId: string
      signal: AbortSignal
      /** Images saved on this machine for the turn to see, beside its words. */
      images?: readonly string[]
    }
  ): Promise<Delivery> {
    // A send starts the chat's agent, so the host is installed for it as any send would.
    const generation = this.generations.get(chat.sessionId) ?? {}
    this.generations.set(chat.sessionId, generation)
    const sending = this.sending.get(chat.sessionId) ?? new Set<object>()
    const attempt = {}
    sending.add(attempt)
    this.sending.set(chat.sessionId, sending)
    const current = () => this.generations.get(chat.sessionId) === generation
    let window = this.replyWindow(chat.sessionId)
    const reply =
      delivery.reply && delivery.deliveryId && answersThroughOutbox(key.source)
        ? { ...delivery.reply, conversation: key, deliveryId: delivery.deliveryId }
        : null
    // Listed at admission: the turn it starts may begin before the send returns, and none before.
    let sent: { deliveryId: string; sentAt: number } | undefined
    const admitted = (operationId: string) => {
      if (current()) {
        sent = this.admit(chat.sessionId, delivery.deliveryId)
        window = this.replyWindow(chat.sessionId)
        window.set(attempt, reply ? { ...reply, operationId } : null)
      }
    }
    const outcome = await deliverToChat((await chats?.ensure()) ?? null, chatLink(key, chat), {
      ...delivery,
      admitted
    }).finally(() => {
      sending.delete(attempt)
      if (this.sending.get(chat.sessionId) === sending && sending.size === 0) {
        this.sending.delete(chat.sessionId)
      }
    })
    if (!current()) {
      return outcome
    }
    // Only a committed send's turn is the delivery's. A bot's title reads what its asker wrote.
    if (outcome.outcome === 'refused') {
      window.delete(attempt)
      if (
        window.size === 0 &&
        !this.sending.has(chat.sessionId) &&
        this.replyDeliveries.get(chat.sessionId) === window
      ) {
        this.replyDeliveries.delete(chat.sessionId)
      }
      const left = this.unstarted.get(chat.sessionId)?.filter((entry) => entry !== sent)
      if (left?.length) {
        this.unstarted.set(chat.sessionId, left)
      } else {
        this.unstarted.delete(chat.sessionId)
      }
    } else {
      // A turn end that consumed this admission leaves nothing for a late receipt to restore.
      if (this.replyDeliveries.get(chat.sessionId) === window) {
        if (!sent) {
          window.set(attempt, null)
        }
        this.delivered.add(chat.sessionId)
      }
      this.link(key, chat, delivery.asker?.text ?? delivery.text, delivery.asker)
    }
    return outcome
  }
}
