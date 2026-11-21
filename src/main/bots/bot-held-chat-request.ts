// A request bound for a chat whose last turn failed: a chat named with --chat holds it, so it runs
// in a chat of its own; the Home Chat queues it. Either way the sender is told.
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { chatHoldsAgentMail } from './bot-chat-mail-hold'
import { botRequestSentNext, type BotRequestRecord } from './bot-request-view'

/** A chat a failed turn holds: `queued` when the request waits in it, else it went to a new chat. */
export type HeldChat = { chat: string; queued: boolean }

/** The chat a sender named, when a failed turn holds it and the mail asks for something. */
export async function namedChatHeld(
  runtime: OrcaRuntimeService,
  purpose: string,
  chat: string | null
): Promise<HeldChat | null> {
  return purpose !== 'status' && chat && (await chatHoldsAgentMail(runtime, chat))
    ? { chat, queued: false }
    : null
}

/** The Home Chat, when a failed turn holds it: the request queues there. */
export async function homeChatHeld(
  runtime: OrcaRuntimeService,
  chat: string
): Promise<HeldChat | null> {
  return (await chatHoldsAgentMail(runtime, chat)) ? { chat, queued: true } : null
}

/** The sender's next step, led by why its request waits or where it went instead of the held chat. */
export function heldChatSentNext(
  record: BotRequestRecord,
  held: HeldChat | null | undefined,
  address: string
): string {
  const next = botRequestSentNext(record)
  if (!held) {
    return next
  }
  const bot = record.toBotName
  if (held.queued) {
    return `${bot}'s Home chat is paused after a failed turn, so this is queued there and runs when that chat continues. ${next}`
  }
  const chat = address.replace(/^orca_session_id:/, '')
  return `${bot}'s chat ${held.chat} is stopped after a failed turn, so this went to a new chat of ${bot} instead (--chat ${chat}). ${next}`
}
