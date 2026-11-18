import {
  parseBotAccessRequestDeepLink,
  parseBotDeepLink,
  type BotDeepLink
} from '../../../src/shared/bot-deep-link'

/** A bot link the phone opens: a bot's chat, or the owner's "Review in Orca" on a request for access. */
export type BotSessionLinkTarget = BotDeepLink & {
  kind: 'session'
  sessionId: string
  conversation: NonNullable<BotDeepLink['conversation']>
}

export type BotLinkTarget =
  | BotSessionLinkTarget
  | { kind: 'bot'; botId: string }
  | { kind: 'access-request'; token: string }

export function parseBotLinkTarget(url: string): BotLinkTarget | null {
  const bot = parseBotDeepLink(url)
  if (bot) {
    return bot.sessionId && bot.conversation
      ? { ...bot, kind: 'session', sessionId: bot.sessionId, conversation: bot.conversation }
      : { kind: 'bot', botId: bot.botId }
  }
  const request = parseBotAccessRequestDeepLink(url)
  return request ? { kind: 'access-request', token: request.token } : null
}
