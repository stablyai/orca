// The DMs a bot's Chat may answer from a turn that started on its own: one a worker start saved,
// until anything from another conversation reaches that Chat (a missed post, never one into the
// wrong DM). Kept in memory with the seam: a restart, sign-out or account switch loses them all.
import { randomBytes } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { CONNECTOR_SOURCES } from '../../shared/connectors/external-conversation-link'
import { conversationId, type ConversationKey } from './external-conversation-types'

// Enough to find a turn's opener behind the messages its own DM sent since; older means unknown.
const ARRIVALS_KEPT = 32
const MAX_DMS_PER_CHAT = 64
// Outside words whose conversation Orca can't name: they void every saved DM.
const UNKNOWN = 'unknown'

type Arrival = { deliveryId: string | null; conversation: string }

export class BotChatSavedDms {
  // Only for bot Chats, the chats that can save a DM: one per bot, not one per thread.
  private readonly arrivals = new Map<string, { botId: string; log: Arrival[] }>()
  private readonly saved = new Map<string, { botId: string; dms: Map<string, ConversationKey> }>()

  /** Recorded before it is sent: anything a conversation brings a chat voids every DM saved there
   *  but its own, whichever turn it opens or joins. Null: words from somewhere Orca can't name. */
  arrived(
    sessionId: string,
    key: ConversationKey | null,
    { botChat, deliveryId }: { botChat?: string; deliveryId?: string } = {}
  ): void {
    const conversation = key ? conversationId(key) : UNKNOWN
    // Once a chat is a bot's Chat, everything that reaches it is logged, whatever it came as.
    let entry = this.arrivals.get(sessionId)
    if (!entry && botChat) {
      // A bot has one Chat: a new one retires what the old one kept.
      this.forget((chat, id) => chat.botId === botChat && id !== sessionId)
      entry = { botId: botChat, log: [] }
    }
    if (entry) {
      entry.log.push({ deliveryId: deliveryId ?? null, conversation })
      if (entry.log.length > ARRIVALS_KEPT) {
        entry.log.shift()
      }
      this.arrivals.set(sessionId, entry)
    }
    const chat = this.saved.get(sessionId)
    for (const [to, dm] of chat?.dms ?? []) {
      if (conversationId(dm) !== conversation) {
        chat?.dms.delete(to)
      }
    }
  }

  /** Any message a chat took that carries someone else's words (a delivery, an event's run, a
   *  returned card sent again), however it got there; the owner's typing and worker mail don't. */
  admitted(sessionId: string, body: AgentJournalMessageItem): void {
    const named = [
      ...(body.connectorConversation ? [body.connectorConversation] : []),
      ...(body.connectorDelivery ? [body.connectorDelivery.conversation] : []),
      ...(body.connectorClaim?.origin.map((each) => each.conversation) ?? [])
    ].map((each) => {
      const source = CONNECTOR_SOURCES.find((known) => known === each.source)
      return source ? { source, externalId: each.externalId } : null
    })
    const outside =
      named.length > 0 ||
      body.origin === 'connector' ||
      body.origin === 'automation-run' ||
      body.memorySource !== undefined ||
      body.asker !== undefined ||
      body.carriedAskers !== undefined
    if (!outside) {
      return
    }
    const one = named[0]
    const same = one && named.every((each) => each && conversationId(each) === conversationId(one))
    this.arrived(sessionId, same ? one : null)
  }

  /** Saves the DM only when the delivery that opened the turn reached this chat and nothing from
   *  another conversation has since: the saving turn holds no one else's words. Returns the `--to`
   *  this save alone answers to, so a note voided earlier never works again. */
  save(
    sessionId: string,
    botId: string,
    { key, openerDeliveryId, url }: { key: ConversationKey; openerDeliveryId: string; url: string }
  ): string | null {
    const log = this.arrivals.get(sessionId)?.log ?? []
    const conversation = conversationId(key)
    let at = log.length - 1
    while (at >= 0 && log[at]?.deliveryId !== openerDeliveryId) {
      at -= 1
    }
    if (at < 0 || log.slice(at).some((arrival) => arrival.conversation !== conversation)) {
      return null
    }
    const to = `${url}#${randomBytes(4).toString('hex')}`
    const chat = this.saved.get(sessionId)
    const dms = chat?.botId === botId ? chat.dms : new Map<string, ConversationKey>()
    dms.set(to, key)
    if (dms.size > MAX_DMS_PER_CHAT) {
      dms.delete(dms.keys().next().value!)
    }
    this.saved.set(sessionId, { botId, dms })
    return to
  }

  /** The DM `to` names, while it is still this bot's to answer from this chat. */
  savedDm(sessionId: string, botId: string, to: string): ConversationKey | null {
    const chat = this.saved.get(sessionId)
    return chat?.botId === botId ? (chat.dms.get(to) ?? null) : null
  }

  /** A deleted bot's saved DMs go with it. */
  forgetBot(botId: string): void {
    this.forget((chat) => chat.botId === botId)
  }

  /** A watch gap, sign-out or account switch: nothing proves who has written since. */
  clear(): void {
    this.arrivals.clear()
    this.saved.clear()
  }

  private forget(matches: (chat: { botId: string }, sessionId: string) => boolean): void {
    for (const chats of [this.saved, this.arrivals]) {
      for (const [sessionId, chat] of chats) {
        if (matches(chat, sessionId)) {
          chats.delete(sessionId)
        }
      }
    }
  }
}
