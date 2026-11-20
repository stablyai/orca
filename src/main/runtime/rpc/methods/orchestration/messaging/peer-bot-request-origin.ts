// A request a paired computer sent: its way back, filed with it, and the sender's own rules.
import type { BotRequestPeerLink } from '../../../../orchestration/db/bot-requests/bot-request-store'

export type PeerBotRequestOrigin = BotRequestPeerLink & {
  /** The sender tells its asker once per question. */
  questionNotice?: 'once'
  /** The same send from the same turn on the sender's computer. */
  sendKey?: string
}

/** What admission stores for a request: the rule its asker is told by (a paired sender from before
 *  it keeps the earlier one), a paired sender's own send identity, and its route back. */
export function peerBotRequestAdmission(origin: PeerBotRequestOrigin | undefined): {
  debtRule: boolean
  sendKey?: string
  peerLink?: BotRequestPeerLink
} {
  if (!origin) {
    return { debtRule: true }
  }
  return {
    debtRule: origin.questionNotice === 'once',
    ...(origin.sendKey
      ? { sendKey: JSON.stringify(['peer', origin.peerFingerprint, origin.sendKey]) }
      : {}),
    peerLink: {
      conversationId: origin.conversationId,
      peerFingerprint: origin.peerFingerprint,
      senderLabel: origin.senderLabel
    }
  }
}
