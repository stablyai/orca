// A request's own conversation in the receiving bot's home: a teammate's, or one sent with `--chat new`.
// It acts for whom the request is for, and is closed again when the request went nowhere.
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
import { noteInChat } from '../../../../../bots/bot-chat-status-line'
import {
  botRequestElsewhereNote,
  botRequestSenderName,
  type BotRequestRecord
} from '../../../../../bots/bot-request-view'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

/** A teammate's request, or one sent with `--chat new`, runs in a conversation of its own in the bot's
 *  home, never in the owner's Chat; the conversation acts for whom the request is for. */
async function requestConversation(
  runtime: OrcaRuntimeService,
  bot: Bot,
  record: BotRequestRecord,
  subject: string
): Promise<{ sessionId: string; title: string }> {
  const sessionId = await startBotSession(runtime, bot, {
    background: true,
    actsFor: {
      actsFor: record.askers,
      ...(record.triggeredBy ? { triggeredBy: record.triggeredBy } : {})
    }
  })
  // A bot's own new chat is named for its subject alone; another sender's names who sent it.
  const own = record.fromBotId === bot.id
  const title = (own ? subject : `${botRequestSenderName(record)}: ${subject}`).slice(0, 80)
  await (
    await requireStructuredHost(runtime)
  )
    .setUserConversationName(sessionId, title, 'rename')
    .catch((error: unknown) => console.warn('[bots] could not name a request conversation', error))
  return { sessionId, title }
}

/** Admits a reserved request into a conversation of its own; when it goes nowhere the conversation
 *  is closed again and the reservation given back. `home`: the owner's Chat, told it went elsewhere
 *  (`chat` is null while the bot has none); null tells none. `tab`: the conversation is a chat the
 *  sender asked for (`--chat new`), so it gets a tab in the bot's home and lists under the bot like a
 *  chat opened from the tab bar; a teammate's waits in the bot's Chats. */
export async function admitInOwnConversation(
  runtime: OrcaRuntimeService,
  bot: Bot,
  record: BotRequestRecord,
  subject: string,
  home: { chat: string | null } | null,
  tab: boolean,
  reservation: {
    admit: (address: string) => { sent: boolean; receipt: unknown }
    release: () => void
  }
): Promise<unknown> {
  let started: { sessionId: string; title: string }
  try {
    started = await requestConversation(runtime, bot, record, subject)
  } catch (error) {
    reservation.release()
    throw error
  }
  const { sessionId, title } = started
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
  if (home) {
    noteInChat(home.chat ?? undefined, botRequestElsewhereNote(record, title))
  }
  if (tab) {
    await showConversationTab(runtime, bot, sessionId)
  }
  return admitted.receipt
}

/** A tab for the new chat in the bot's home, without taking focus. The request is already delivered,
 *  so a tab that can't be shown only leaves the chat in the bot's Chats, where it was before. */
async function showConversationTab(
  runtime: OrcaRuntimeService,
  bot: Bot,
  sessionId: string
): Promise<void> {
  await runtime
    .publishStructuredAgentSessionTab({
      workspaceId: folderWorkspaceKey(bot.folderWorkspaceId),
      sessionId,
      agent: bot.agent,
      activate: false
    })
    .catch((error: unknown) => console.warn('[bots] could not show a new chat tab', error))
}

export function sessionAddress(sessionId: string): string {
  if (!isOrcaSessionId(sessionId)) {
    throw new OrchestrationError('bot_not_found', 'That bot has no conversation to mail.')
  }
  return formatOrcaSessionAddress(sessionId)
}
