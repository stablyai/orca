// A bot request bound for a chat whose last turn failed: that chat holds it, so it runs in a chat of
// its own, and the sender is told where.
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { chatHoldsAgentMail } from './bot-chat-mail-hold'
import { botRequestSentNext, type BotRequestRecord } from './bot-request-view'

/** The chat a sender named, when a failed turn holds it and the mail asks for something. */
export async function namedChatHeld(
  runtime: OrcaRuntimeService,
  purpose: string,
  chat: string | null
): Promise<string | null> {
  return purpose !== 'status' && chat && (await chatHoldsAgentMail(runtime, chat)) ? chat : null
}

/** The sender's next step, led by where its request went instead of the held chat, so it mails
 *  follow-ups there. */
export function heldChatSentNext(
  record: BotRequestRecord,
  held: string | null,
  address: string
): string {
  const next = botRequestSentNext(record)
  if (!held) {
    return next
  }
  const bot = record.toBotName
  const chat = address.replace(/^orca_session_id:/, '')
  return `${bot}'s chat ${held} is stopped after a failed turn, so this went to a new chat of ${bot} instead (--chat ${chat}). ${next}`
}
