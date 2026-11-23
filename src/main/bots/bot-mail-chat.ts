// Where a bot's mail meant for one of its chats lands: that chat while it takes mail, else Home Chat,
// including the reports of workers a room member started once that member's chat closes.
import type { Bot } from '../../shared/bot-types'
import type { BotGroupMember } from '../../shared/bots/bot-group'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import { handOverCoordinatorChatRuns } from '../runtime/orchestration/db/runs/run-coordinator-handover'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { closeStructuredAgentSessionChild } from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import { botChatTakingMail } from '../runtime/rpc/methods/bots-chats'
import { runtimeBotChats } from './bot-chat-session'

/** The session mail for `chatId` reaches; Home Chat once that chat takes none (a room deleted or
 *  left, a chat closed), so item changes and worker reports are never left without a reader. */
export async function botMailSession(
  runtime: OrcaRuntimeService,
  bot: Bot,
  chatId: string
): Promise<string> {
  return (
    (await botChatTakingMail(runtime, bot, chatId))?.sessionId ??
    (await runtimeBotChats(runtime).ensure(bot.id))
  )
}

/** Closes a room member's chat. The workers it started still report, so its Runs go to the chat
 *  that reads the bot's mail for it now (Home Chat), as its items' mail does. */
export async function closeMemberChat(
  runtime: OrcaRuntimeService,
  member: BotGroupMember
): Promise<void> {
  await closeStructuredAgentSessionChild(member.sessionId, { runtime })
  const db = runtime.getOrchestrationDb()
  const bot = runtime.bots.list().find((entry) => entry.id === member.botId)
  const from = member.sessionId
  if (
    !bot ||
    !isOrcaSessionId(from) ||
    db.runsBoundToCoordinator({ orcaSessionId: from, paneKey: null, terminalHandle: null })
      .length === 0
  ) {
    return
  }
  const to = await botMailSession(runtime, bot, from)
  if (isOrcaSessionId(to)) {
    handOverCoordinatorChatRuns(db, from, to)
  }
}
