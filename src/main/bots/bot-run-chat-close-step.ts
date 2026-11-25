// One ended run chat's close, under the bot's lock so mail into it waits: judged again there, closed
// only while idle, then what was queued or coordinated there goes on to the Home Chat. A move that
// fails after the close is tried again on the bot's next look.
import type { Bot } from '../../shared/bot-types'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
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

type ChatLock = Pick<ReturnType<typeof botChatSessions>, 'underChatLock'>

/** A closed run chat of the bot: its id in `orca bot chats`, and the session that was closed. */
export type ClosedRunChat = { chatId: string; sessionId: string }

/** Closed run chats whose queued cards did not move, by bot. Kept in this process only; the close
 *  paused that queue, so the cards wait there, running nowhere, until a later look moves them. */
const owingCards = new Map<string, Set<string>>()

/** Both moves are tried, so one failing does not skip the other. A Run that did not move stays bound
 *  to the closed chat, which is how the next look finds it, after a restart too. */
async function moveToHome(
  steps: RunChatCloseSteps,
  host: BotChatHost,
  botId: string,
  from: string,
  home: string
): Promise<void> {
  const owing = owingCards.get(botId) ?? new Set<string>()
  owingCards.set(botId, owing)
  await steps.carry(host, from, home).then(
    () => owing.delete(from),
    (error: unknown) => {
      owing.add(from)
      console.warn('[bots] could not move the queued messages of a closed run chat', error)
    }
  )
  try {
    steps.handOver(from, home)
  } catch (error) {
    console.warn('[bots] could not hand over the Runs of a closed run chat', error)
  }
}

export function closeRunChatUnderLock(
  chats: ChatLock,
  steps: RunChatCloseSteps,
  botId: string,
  sessionId: string,
  ended: () => Promise<boolean>
): Promise<RunChatCloseOutcome> {
  return chats.underChatLock(botId, async (host, bot, chat) => {
    // The bot as it is now: the owner may have turned the setting off while this waited.
    if (bot.closeEndedRuns !== true || sessionId === bot.chatSessionId || !(await ended())) {
      return 'kept'
    }
    // Opened first, so a Home Chat that cannot open leaves the run chat open for the next look.
    const home = await chat()
    const closed = await steps.close(sessionId)
    if (!closed.stopped) {
      return 'failed'
    }
    await moveToHome(steps, host, botId, sessionId, home)
    await steps.dropUnreadMail(bot, sessionId)
    return 'closed'
  })
}

/** Closed run chats a failed move left something on, each moved again under the lock: those still
 *  coordinating a Run, read from the Runs so a restart keeps them, and those whose cards stayed. */
export async function settleClosedRunChats(
  chats: ChatLock,
  steps: RunChatCloseSteps,
  db: OrchestrationDb,
  botId: string,
  closed: readonly ClosedRunChat[],
  isRunChat: (chatId: string) => Promise<boolean>
): Promise<void> {
  const owing = owingCards.get(botId)
  // One read narrows the bot's closed chats to those any Run names before each is checked.
  const named = new Set(
    db.db
      .prepare(
        `SELECT DISTINCT coordinator_orca_session_id AS id FROM runs
         WHERE coordinator_orca_session_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(closed.map((chat) => chat.sessionId)))
      .map((row) => String(row.id))
  )
  const coordinates = (id: string) =>
    named.has(id) &&
    isOrcaSessionId(id) &&
    db.runsBoundToCoordinator({ orcaSessionId: id, paneKey: null, terminalHandle: null }).length > 0
  for (const { chatId, sessionId } of closed) {
    if ((owing?.has(sessionId) || coordinates(sessionId)) && (await isRunChat(chatId))) {
      await chats.underChatLock(botId, async (host, _bot, chat) =>
        moveToHome(steps, host, botId, sessionId, await chat())
      )
    }
  }
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
  return {
    close: (botId: string, sessionId: string, ended: () => Promise<boolean>) =>
      closeRunChatUnderLock(chats, steps, botId, sessionId, ended),
    settle: (
      botId: string,
      closed: readonly ClosedRunChat[],
      isRunChat: (chatId: string) => Promise<boolean>
    ) => settleClosedRunChats(chats, steps, runtime.getOrchestrationDb(), botId, closed, isRunChat)
  }
}
