// A request sent with `--chat new` runs in a chat of its own in the receiving bot's home. It acts for
// whom the request is for, and is closed again when the request went nowhere.
import type { Bot } from '../../../../../../shared/bot-types'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../shared/agent-session/identity/orca-session-address'
import {
  closeBotSession,
  requireStructuredHost,
  startBotSession
} from '../../../../../bots/bot-chat-session'
import { showBotSessionTab } from '../../../../../bots/bot-session-tab-show'
import { botRequestChatTitle, type BotRequestRecord } from '../../../../../bots/bot-request-view'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

/** The chat `--chat new` starts in the bot's home; it acts for whom the request is for. */
async function requestConversation(
  runtime: OrcaRuntimeService,
  bot: Bot,
  record: BotRequestRecord,
  subject: string
): Promise<string> {
  const sessionId = await startBotSession(runtime, bot, {
    background: true,
    actsFor: {
      actsFor: record.askers,
      ...(record.triggeredBy ? { triggeredBy: record.triggeredBy } : {})
    }
  })
  const title = botRequestChatTitle(record, bot.id, subject)
  await (
    await requireStructuredHost(runtime)
  )
    .setUserConversationName(sessionId, title, 'rename')
    .catch((error: unknown) => console.warn('[bots] could not name a request conversation', error))
  return sessionId
}

/** Admits a reserved request into a chat of its own; when it goes nowhere the chat is closed again
 *  and the reservation given back. The chat gets a tab in the bot's home and lists under the bot like
 *  a chat opened from the tab bar, whoever it acts for: the owner's Orca holds it either way. */
export async function admitInNewChat(
  runtime: OrcaRuntimeService,
  bot: Bot,
  record: BotRequestRecord,
  subject: string,
  reservation: {
    admit: (address: string) => { sent: boolean; receipt: unknown }
    release: () => void
  }
): Promise<unknown> {
  let sessionId: string
  try {
    sessionId = await requestConversation(runtime, bot, record, subject)
  } catch (error) {
    reservation.release()
    throw error
  }
  const close = () =>
    closeBotSession(runtime, sessionId).catch((error: unknown) =>
      console.warn('[bots] could not close an unused request conversation', error)
    )
  let admitted: { sent: boolean; receipt: unknown }
  try {
    admitted = reservation.admit(sessionAddress(sessionId))
  } catch (error) {
    reservation.release()
    await close()
    throw error
  }
  if (!admitted.sent) {
    reservation.release()
    await close()
    return admitted.receipt
  }
  await showConversationTab(runtime, bot, sessionId)
  return admitted.receipt
}

/** The request is already delivered, so a tab that can't be shown only leaves the chat in the bot's
 *  Chats, where it was before; reopening it from there publishes the same tab. */
async function showConversationTab(
  runtime: OrcaRuntimeService,
  bot: Bot,
  sessionId: string
): Promise<void> {
  await showBotSessionTab(runtime, bot, sessionId).catch((error: unknown) =>
    console.warn('[bots] could not show a new chat tab', error)
  )
}

export function sessionAddress(sessionId: string): string {
  if (!isOrcaSessionId(sessionId)) {
    throw new OrchestrationError('bot_not_found', 'That bot has no conversation to mail.')
  }
  return formatOrcaSessionAddress(sessionId)
}
