// One ended run chat's close, under the bot's lock so mail into it waits: judged again there, closed
// only while idle, then what was queued or coordinated there goes on to the Home Chat.
import type { Bot } from '../../shared/bot-types'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { closeStructuredAgentSessionChild } from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import { handOverCoordinatorChatRuns } from '../runtime/orchestration/db/runs/run-coordinator-handover'
import { runtimeBotChats, type BotChatHost, type botChatSessions } from './bot-chat-session'
import { carryQueuedMessages } from './bot-chat-queued-carry'
import { dropReplacedChatMail } from './bot-chat-replacement'

export type RunChatCloseSteps = {
  close: (sessionId: string) => Promise<{ stopped: boolean }>
  carry: (host: BotChatHost, from: string, to: string) => Promise<void>
  handOver: (from: string, to: string) => void
  /** Mail admitted just before the close: its senders hear, as for a replaced Chat. */
  dropUnreadMail: (bot: Bot, from: string) => Promise<void>
}

export type RunChatCloseOutcome = 'kept' | 'failed' | 'closed'

export function closeRunChatUnderLock(
  chats: Pick<ReturnType<typeof botChatSessions>, 'underChatLock'>,
  steps: RunChatCloseSteps,
  botId: string,
  sessionId: string,
  ended: () => Promise<boolean>
): Promise<RunChatCloseOutcome> {
  return chats.underChatLock(botId, async (host, bot, chat) => {
    if (sessionId === bot.chatSessionId || !(await ended())) {
      return 'kept'
    }
    const closed = await steps.close(sessionId)
    if (!closed.stopped) {
      return 'failed'
    }
    const home = await chat()
    await steps.carry(host, sessionId, home)
    steps.handOver(sessionId, home)
    await steps.dropUnreadMail(bot, sessionId)
    return 'closed'
  })
}

export function runtimeRunChatClose(runtime: OrcaRuntimeService) {
  const steps: RunChatCloseSteps = {
    // A turn or send that started after the last look refuses the close.
    close: (sessionId) =>
      closeStructuredAgentSessionChild(sessionId, {
        runtime,
        admitClose: (work) => work.state === 'idle'
      }),
    carry: carryQueuedMessages,
    handOver: (from, to) => {
      if (isOrcaSessionId(from) && isOrcaSessionId(to)) {
        handOverCoordinatorChatRuns(runtime.getOrchestrationDb(), from, to)
      }
    },
    dropUnreadMail: (bot, from) => dropReplacedChatMail(runtime, bot.id, from)
  }
  const chats = runtimeBotChats(runtime)
  return (botId: string, sessionId: string, ended: () => Promise<boolean>) =>
    closeRunChatUnderLock(chats, steps, botId, sessionId, ended)
}
