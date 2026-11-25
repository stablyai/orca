// One ended run chat's close, under the bot's lock so mail into it waits: judged again there, closed
// only while idle and shown in no tab, then what was queued or coordinated there goes on to the
// Home Chat. A move that fails after the close is tried again on the bot's next look, after a
// restart too.
import type { Bot } from '../../shared/bot-types'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { closeStructuredAgentSessionChild } from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { handOverCoordinatorChatRuns } from '../runtime/orchestration/db/runs/run-coordinator-handover'
import {
  forgetUnfinishedRunChatClose,
  recordUnfinishedRunChatClose,
  unfinishedRunChatCloses
} from '../runtime/orchestration/db/bot-requests/bot-run-chat-unfinished-closes-store'
import { runtimeBotChats, type BotChatHost, type botChatSessions } from './bot-chat-session'
import { carryQueuedMessages } from './bot-chat-queued-carry'
import { dropReplacedChatMail } from './bot-chat-replacement'

export type RunChatCloseSteps = {
  /** `tabOpen` when a tab showed the chat at the last word before Stop, which refuses it. */
  close: (sessionId: string) => Promise<{ stopped: boolean; tabOpen?: boolean }>
  /** False when a card that moves stayed behind. */
  carry: (host: BotChatHost, from: string, to: string) => Promise<boolean>
  handOver: (from: string, to: string) => void
  /** Mail admitted just before the close: its senders hear, as for a replaced Chat. */
  dropUnreadMail: (bot: Bot, from: string) => Promise<void>
  /** Closed run chats whose moves to the Home Chat have yet to finish, kept across restarts. */
  owed: {
    add: (botId: string, sessionId: string) => void
    forget: (sessionId: string) => void
    list: (botId: string) => readonly string[]
  }
}

export type RunChatCloseOutcome = 'kept' | 'tab-open' | 'failed' | 'closed'

type ChatLock = Pick<ReturnType<typeof botChatSessions>, 'underChatLock'>

const warned =
  (what: string) =>
  (error: unknown): false => {
    console.warn(`[bots] could not ${what} of a closed run chat`, error)
    return false
  }

/** Every move is tried, so one failing does not hold up the rest, and each is safe to repeat. The
 *  record goes only once all three finished; until then the next look finds the chat and tries
 *  again. The close paused that chat's queue, so cards that stayed wait there, running nowhere. */
async function finishClose(
  steps: RunChatCloseSteps,
  host: BotChatHost,
  bot: Bot,
  from: string,
  home: string
): Promise<void> {
  const moved = await steps.carry(host, from, home).catch(warned('move the queued messages'))
  let handedOver = true
  try {
    steps.handOver(from, home)
  } catch (error) {
    handedOver = warned('hand over the Runs')(error)
  }
  const told = await steps
    .dropUnreadMail(bot, from)
    .then(() => true, warned('tell the senders of the unread mail'))
  if (moved && handedOver && told) {
    try {
      steps.owed.forget(from)
    } catch (error) {
      warned('forget the finished close')(error)
    }
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
    // Recorded before the close, so a crash between the close and the moves still leaves it.
    steps.owed.add(botId, sessionId)
    const closed = await steps.close(sessionId)
    if (!closed.stopped) {
      steps.owed.forget(sessionId)
      return closed.tabOpen ? 'tab-open' : 'failed'
    }
    await finishClose(steps, host, bot, sessionId, home)
    return 'closed'
  })
}

/** The bot's chats now, by the session running each: a record is finished only for a chat that is
 *  closed, and one whose chat is open again, or never closed, is dropped. */
export type RunChatSessionsNow = { closed: ReadonlySet<string>; open: ReadonlySet<string> }

/** Each close a failed move left unfinished is finished again, under the lock. */
export async function settleClosedRunChats(
  chats: ChatLock,
  steps: RunChatCloseSteps,
  botId: string,
  now: RunChatSessionsNow
): Promise<void> {
  for (const sessionId of steps.owed.list(botId)) {
    if (now.open.has(sessionId)) {
      steps.owed.forget(sessionId)
    } else if (now.closed.has(sessionId)) {
      // One chat that cannot be moved now is tried again on the next look; the rest go on.
      await chats
        .underChatLock(botId, async (host, bot, chat) =>
          finishClose(steps, host, bot, sessionId, await chat())
        )
        .catch(warned('finish the moves'))
    }
  }
}

/** The bot has a close to finish; read before its chats, which costs more. */
export function runChatClosesOwed(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb'>,
  botId: string
): boolean {
  return unfinishedRunChatCloses(runtime.getOrchestrationDb(), botId).length > 0
}

export function runtimeRunChatClose(runtime: OrcaRuntimeService) {
  const steps: RunChatCloseSteps = {
    // A turn or send that started, or a tab that opened, after the last look refuses the close.
    close: async (sessionId) => {
      let tabOpen = false
      const outcome = await closeStructuredAgentSessionChild(sessionId, {
        runtime,
        admitClose: (work) => {
          tabOpen = (getStructuredAgentSessionHost()?.getSessionTabId(sessionId) ?? null) !== null
          return work.state === 'idle' && !tabOpen
        }
      })
      return { stopped: outcome.stopped, tabOpen }
    },
    carry: carryQueuedMessages,
    handOver: (from, to) => {
      if (isOrcaSessionId(from) && isOrcaSessionId(to)) {
        handOverCoordinatorChatRuns(runtime.getOrchestrationDb(), from, to)
      }
    },
    dropUnreadMail: (bot, from) => dropReplacedChatMail(runtime, bot.id, from),
    owed: {
      add: (botId, sessionId) =>
        recordUnfinishedRunChatClose(runtime.getOrchestrationDb(), botId, sessionId),
      forget: (sessionId) => forgetUnfinishedRunChatClose(runtime.getOrchestrationDb(), sessionId),
      list: (botId) => unfinishedRunChatCloses(runtime.getOrchestrationDb(), botId)
    }
  }
  const chats = runtimeBotChats(runtime)
  return {
    close: (botId: string, sessionId: string, ended: () => Promise<boolean>) =>
      closeRunChatUnderLock(chats, steps, botId, sessionId, ended),
    settle: (botId: string, now: RunChatSessionsNow) =>
      settleClosedRunChats(chats, steps, botId, now)
  }
}
