// One ended run chat's close, under the bot's lock so mail into it waits: judged again there, closed
// only while idle and not in front, then what was queued or coordinated there goes on to the
// Home Chat. A tab behind another closes with the chat. A move that fails after the close is tried again on the bot's next look, after a
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
import { runChatTabInFront } from './bot-run-chat-facts'

export type RunChatCloseSteps = {
  /** `tabInFront` when the chat's tab was in front at the last word before Stop, which refuses it.
   *  `whenStopped` when the stop waits for the agent's start to end: true once the chat closed. */
  close: (
    sessionId: string
  ) => Promise<{ stopped: boolean; tabInFront?: boolean; whenStopped?: Promise<boolean> }>
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
  /** Chats whose stop waited for their agent's start, until their moves finished: they read as
   *  open until that start ends, and their record must stay. In memory, as a restart ends the
   *  start too. */
  stopping: Set<string>
}

/** `stopping`: the chat closes once its agent's start ends, and the moves follow then. */
export type RunChatCloseOutcome = 'kept' | 'tab-in-front' | 'failed' | 'stopping' | 'closed'

type ChatLock = Pick<ReturnType<typeof botChatSessions>, 'underChatLock'>

const warned =
  (what: string) =>
  (error: unknown): false => {
    console.warn(`[bots] could not ${what} of a closed run chat`, error)
    return false
  }

/** A record that cannot be dropped now is dropped on a later look, which finds the chat open, or
 *  finishes its moves again, which is safe; so the failure holds up nothing. */
function forget(steps: RunChatCloseSteps, sessionId: string): void {
  try {
    steps.owed.forget(sessionId)
  } catch (error) {
    warned('forget the record')(error)
  }
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
    steps.stopping.delete(from)
    forget(steps, from)
  }
}

const finishUnderLock = (
  chats: ChatLock,
  steps: RunChatCloseSteps,
  botId: string,
  sessionId: string
): Promise<void> =>
  chats.underChatLock(botId, async (host, bot, chat) =>
    finishClose(steps, host, bot, sessionId, await chat())
  )

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
    if (!closed.stopped && closed.whenStopped) {
      // That start may end long after, so the moves wait for it outside the lock. The record stays
      // until they finish, so a stop that never proves itself is judged on a later look.
      steps.stopping.add(sessionId)
      void closed.whenStopped
        .then((stopped) => {
          if (stopped) {
            return finishUnderLock(chats, steps, botId, sessionId)
          }
          steps.stopping.delete(sessionId)
          return undefined
        })
        .catch(warned('finish the moves'))
      return 'stopping'
    }
    if (!closed.stopped) {
      forget(steps, sessionId)
      return closed.tabInFront ? 'tab-in-front' : 'failed'
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
      // One that reads open only while its stop waits, or as read before that stop ended, stays.
      if (!steps.stopping.has(sessionId)) {
        forget(steps, sessionId)
      }
    } else if (now.closed.has(sessionId)) {
      // One chat that cannot be moved now is tried again on the next look; the rest go on.
      await finishUnderLock(chats, steps, botId, sessionId).catch(warned('finish the moves'))
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

const stopsWaiting = new Set<string>()

export function runtimeRunChatClose(runtime: OrcaRuntimeService) {
  const steps: RunChatCloseSteps = {
    // A turn or send that started, or a tab that came to the front, after the last look refuses it.
    close: async (sessionId) => {
      let tabInFront = false
      const outcome = await closeStructuredAgentSessionChild(sessionId, {
        runtime,
        admitClose: (work) => {
          tabInFront = runChatTabInFront(runtime, getStructuredAgentSessionHost(), sessionId)
          return work.state === 'idle' && !tabInFront
        }
      })
      return {
        stopped: outcome.stopped,
        tabInFront,
        ...(outcome.whenStartEnds ? { whenStopped: outcome.whenStartEnds } : {})
      }
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
    },
    stopping: stopsWaiting
  }
  const chats = runtimeBotChats(runtime)
  return {
    close: (botId: string, sessionId: string, ended: () => Promise<boolean>) =>
      closeRunChatUnderLock(chats, steps, botId, sessionId, ended),
    settle: (botId: string, now: RunChatSessionsNow) =>
      settleClosedRunChats(chats, steps, botId, now)
  }
}
