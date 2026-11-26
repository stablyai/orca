// The DMs a bot's Chat may answer from a turn that started on its own: one a worker start saved,
// until anything from another conversation reaches that Chat (a missed post, never one into the
// wrong DM). Kept in memory with the seam: a restart, sign-out or account switch loses them all.
import { conversationId, type ConversationKey } from './external-conversation-types'

// Enough to find a turn's opener behind the messages its own DM sent since; older means unknown.
const ARRIVALS_KEPT = 32
const MAX_DMS_PER_CHAT = 64

type Arrival = { deliveryId: string | null; conversation: string }

export class BotChatSavedDms {
  private readonly arrivals = new Map<string, Arrival[]>()
  private readonly saved = new Map<string, { botId: string; dms: Map<string, ConversationKey> }>()

  /** Recorded before it is sent: anything a conversation brings a chat voids every DM saved there
   *  but its own, whichever turn it opens or joins. */
  arrived(sessionId: string, key: ConversationKey, deliveryId?: string): void {
    const conversation = conversationId(key)
    const log = this.arrivals.get(sessionId) ?? []
    log.push({ deliveryId: deliveryId ?? null, conversation })
    if (log.length > ARRIVALS_KEPT) {
      log.shift()
    }
    this.arrivals.set(sessionId, log)
    const chat = this.saved.get(sessionId)
    for (const [to, dm] of chat?.dms ?? []) {
      if (conversationId(dm) !== conversation) {
        chat?.dms.delete(to)
      }
    }
  }

  /** Saves the DM only when the delivery that opened the turn reached this chat and nothing from
   *  another conversation has since: the saving turn holds no one else's words. */
  save(
    sessionId: string,
    botId: string,
    { key, openerDeliveryId, to }: { key: ConversationKey; openerDeliveryId: string; to: string }
  ): boolean {
    const log = this.arrivals.get(sessionId) ?? []
    const conversation = conversationId(key)
    let at = log.length - 1
    while (at >= 0 && log[at]?.deliveryId !== openerDeliveryId) {
      at -= 1
    }
    if (at < 0 || log.slice(at).some((arrival) => arrival.conversation !== conversation)) {
      return false
    }
    const chat = this.saved.get(sessionId)
    const dms = chat?.botId === botId ? chat.dms : new Map<string, ConversationKey>()
    dms.delete(to)
    dms.set(to, key)
    if (dms.size > MAX_DMS_PER_CHAT) {
      dms.delete(dms.keys().next().value!)
    }
    this.saved.set(sessionId, { botId, dms })
    return true
  }

  /** The DM `to` names, while it is still this bot's to answer from this chat. */
  savedDm(sessionId: string, botId: string, to: string): ConversationKey | null {
    const chat = this.saved.get(sessionId)
    return chat?.botId === botId ? (chat.dms.get(to) ?? null) : null
  }

  /** A deleted bot's saved DMs go with it. */
  forgetBot(botId: string): void {
    for (const [sessionId, chat] of this.saved) {
      if (chat.botId === botId) {
        this.saved.delete(sessionId)
      }
    }
  }

  /** A watch gap, sign-out or account switch: nothing proves who has written since. */
  clear(): void {
    this.arrivals.clear()
    this.saved.clear()
  }
}
