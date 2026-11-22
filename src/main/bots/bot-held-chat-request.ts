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

/** The sender's next step: when a failed turn holds the chat, that the request waits and who unblocks
 *  it, instead of saying the bot has it. */
export function heldChatSentNext(
  record: BotRequestRecord,
  held: HeldChat | null | undefined
): string {
  if (!held) {
    return botRequestSentNext(record)
  }
  const bot = record.toBotName
  const chat = held.home ? 'Home chat' : `chat ${held.chat}`
  const waits = `${bot}'s ${chat} is paused after a failed turn, so this is queued there and has not started. It runs when ${bot}'s owner resumes or sends in that chat, or at the usage-limit reset if automatic continue is on.`
  return record.purpose === 'status'
    ? `${waits} Nothing comes back.`
    : `${waits} Its answer comes back as usual once it runs. Tell the asker in one line that it is waiting on that.`
}
