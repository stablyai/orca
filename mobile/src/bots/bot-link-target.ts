import {
  parseBotAccessRequestDeepLink,
  parseBotDeepLink,
  type BotDeepLink
} from '../../../src/shared/bot-deep-link'

/** A bot link the phone opens: a bot's chat, or the owner's "Review in Orca" on a request for access. */
// Without `sessionId` (a plain thread link) it opens the conversation's own chat, or else the bot.
export type BotSessionLinkTarget = BotDeepLink & {
  kind: 'session'
  conversation: NonNullable<BotDeepLink['conversation']>
  /** The computer the person picked for a thread link; set on the phone, never read from the URL. */
  hostKey?: string
}

export type BotLinkTarget =
  | BotSessionLinkTarget
  // `conversation`: a thread link no single computer could open; picking a computer looks it up there.
  | { kind: 'bot'; botId: string; conversation?: BotSessionLinkTarget['conversation'] }
  | { kind: 'access-request'; token: string }

export function parseBotLinkTarget(url: string): BotLinkTarget | null {
  const bot = parseBotDeepLink(url)
  if (bot) {
    return bot.conversation
      ? { ...bot, kind: 'session', conversation: bot.conversation }
      : { kind: 'bot', botId: bot.botId }
  }
  const request = parseBotAccessRequestDeepLink(url)
  return request ? { kind: 'access-request', token: request.token } : null
}
