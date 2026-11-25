// One ended run chat's close, under the bot's lock so mail into it waits: judged again there, closed
// only while idle, then what was queued or coordinated there goes on to the Home Chat. A move that
// fails after the close is tried again on the bot's next look, after a restart too.
import type { Bot } from '../../shared/bot-types'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { closeStructuredAgentSessionChild } from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import { handOverCoordinatorChatRuns } from '../runtime/orchestration/db/runs/run-coordinator-handover'
import {
  forgetOwedRunChatCards,
  oweRunChatCards,
  owedRunChatCards
} from '../runtime/orchestration/db/bot-requests/bot-run-chat-owed-cards-store'
import { runtimeBotChats, type BotChatHost, type botChatSessions } from './bot-chat-session'
import { carryQueuedMessages } from './bot-chat-queued-carry'
import { dropReplacedChatMail } from './bot-chat-replacement'

export type RunChatCloseSteps = {
  close: (sessionId: string) => Promise<{ stopped: boolean }>
  /** False when a card that moves stayed behind. */
  carry: (host: BotChatHost, from: string, to: string) => Promise<boolean>
  handOver: (from: string, to: string) => void
  /** Mail admitted just before the close: its senders hear, as for a replaced Chat. */
  dropUnreadMail: (bot: Bot, from: string) => Promise<void>
  /** Closed run chats whose queued cards have yet to move, kept across restarts. */
  owed: {
    add: (botId: string, sessionId: string) => void
    forget: (sessionId: string) => void
    list: (botId: string) => readonly string[]
  }
}

export type RunChatCloseOutcome = 'kept' | 'failed' | 'closed'

type ChatLock = Pick<ReturnType<typeof botChatSessions>, 'underChatLock'>

/** A closed run chat of the bot: its id in `orca bot chats`, and the session that was closed. */
export type ClosedRunChat = { chatId: string; sessionId: string }

/** Both moves are tried, so one failing does not hold up the other. Cards that stayed keep their
 *  record and a Run that did not move stays bound to the closed chat: either way the next look finds
 *  it. The close paused that chat's queue, so the cards wait there, running nowhere. */
async function moveToHome(
  steps: RunChatCloseSteps,
  host: BotChatHost,
  from: string,
  home: string
): Promise<void> {
  const moved = await steps.carry(host, from, home).catch((error: unknown) => {
    console.warn('[bots] could not move the queued messages of a closed run chat', error)
    return false
  })
  if (moved) {
    steps.owed.forget(from)
  }
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
    // Owed before the close, so a crash between the close and the move still leaves the record.
    steps.owed.add(botId, sessionId)
    const closed = await steps.close(sessionId)
    if (!closed.stopped) {
      steps.owed.forget(sessionId)
      return 'failed'
    }
    await moveToHome(steps, host, sessionId, home)
    await steps.dropUnreadMail(bot, sessionId)
    return 'closed'
  })
}

/** Closed run chats a failed move left something on, each moved again under the lock: those whose
 *  cards are owed and those still coordinating a Run, both read from the database. */
export async function settleClosedRunChats(
  chats: ChatLock,
  steps: RunChatCloseSteps,
  db: OrchestrationDb,
  botId: string,
  closed: readonly ClosedRunChat[],
  isRunChat: (chatId: string) => Promise<boolean>
): Promise<void> {
  const owed = new Set(steps.owed.list(botId))
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
  const settle = async ({ chatId, sessionId }: ClosedRunChat): Promise<void> => {
    if ((owed.has(sessionId) || coordinates(sessionId)) && (await isRunChat(chatId))) {
      await chats.underChatLock(botId, async (host, _bot, chat) =>
        moveToHome(steps, host, sessionId, await chat())
      )
    }
  }
  for (const chat of closed) {
    // One chat that cannot be read or moved now is tried again on the next look; the rest go on.
    await settle(chat).catch((error: unknown) =>
      console.warn('[bots] could not move what a closed run chat left', error)
    )
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
    dropUnreadMail: (bot, from) => dropReplacedChatMail(runtime, bot.id, from),
    owed: {
      add: (botId, sessionId) => oweRunChatCards(runtime.getOrchestrationDb(), botId, sessionId),
      forget: (sessionId) => forgetOwedRunChatCards(runtime.getOrchestrationDb(), sessionId),
      list: (botId) => owedRunChatCards(runtime.getOrchestrationDb(), botId)
    }
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
