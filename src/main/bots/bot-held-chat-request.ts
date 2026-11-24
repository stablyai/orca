// A request bound for a chat whose last turn stopped at a usage limit queues there, and the sender is
// told why it waits. After any other failure the request runs as the chat's next turn.
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { chatHoldsAgentMail } from './bot-chat-mail-hold'
import { botRequestSentNext, type BotRequestRecord } from './bot-request-view'

/** A chat a usage-limited turn holds; `home` when it is the bot's Home Chat. */
export type HeldChat = { chat: string; home: boolean }

/** The chat a request goes to, when a usage-limited turn holds it; null when none does. */
export async function failureHeldChat(
  runtime: OrcaRuntimeService,
  chat: string | null,
  home: boolean
): Promise<HeldChat | null> {
  return chat && (await chatHoldsAgentMail(runtime, chat)) ? { chat, home } : null
}

/** The sender's next step: when a usage limit holds the chat, that the request waits and what
 *  unblocks it, instead of saying the bot has it. */
export function heldChatSentNext(
  record: BotRequestRecord,
  held: HeldChat | null | undefined
): string {
  if (!held) {
    return botRequestSentNext(record)
  }
  const bot = record.toBotName
  const chat = held.home ? 'Home chat' : `chat ${held.chat}`
  const waits = `${bot}'s ${chat} stopped at its usage limit, so this is queued there and has not started. It runs when the chat continues: at the reset if automatic continue is on, or when ${bot}'s owner continues it.`
  return record.purpose === 'status'
    ? `${waits} Nothing comes back.`
    : `${waits} Its answer comes back as usual once it runs. Tell the asker in one line that it is waiting on that.`
}
