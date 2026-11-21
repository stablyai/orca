// A request bound for a chat whose last turn failed queues there like its owner's own follow-ups,
// and the sender is told why it waits.
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { chatHoldsAgentMail } from './bot-chat-mail-hold'
import { botRequestSentNext, type BotRequestRecord } from './bot-request-view'

/** A chat a failed turn holds; `home` when it is the bot's Home Chat. */
export type HeldChat = { chat: string; home: boolean }

/** The chat a request goes to, when a failed turn holds it; null when none does. */
export async function failureHeldChat(
  runtime: OrcaRuntimeService,
  chat: string | null,
  home: boolean
): Promise<HeldChat | null> {
  return chat && (await chatHoldsAgentMail(runtime, chat)) ? { chat, home } : null
}

/** The sender's next step, led by why its request waits when a failed turn holds the chat. */
export function heldChatSentNext(
  record: BotRequestRecord,
  held: HeldChat | null | undefined
): string {
  const next = botRequestSentNext(record)
  if (!held) {
    return next
  }
  const chat = held.home ? 'Home chat' : `chat ${held.chat}`
  return `${record.toBotName}'s ${chat} is paused after a failed turn, so this is queued there and runs when that chat continues. ${next}`
}
