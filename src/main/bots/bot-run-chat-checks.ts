// When a bot's run chats are looked at. No timer runs while nothing happens: when its setting turns
// on (closing what piled up), 10 minutes after each of its runs, and once a quiet window after start,
// for the looks a restart dropped. A bot with a close left to finish is looked at too, setting off.
import type { Bot } from '../../shared/bot-types'
import { RUN_CHAT_QUIET_MS } from '../../shared/bots/bot-run-chat-close'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runChatClosesOwed } from './bot-run-chat-close-step'
import { closeEndedRunChats } from './bot-run-chat-closer'
import { botOfSession } from './bot-session-tabs'

function checkRunChats(runtime: OrcaRuntimeService, bot: Bot): void {
  void closeEndedRunChats(runtime, bot).catch((error: unknown) =>
    console.warn('[bots] run chat check failed', error)
  )
}

const looksAt = (runtime: OrcaRuntimeService, bot: Bot): boolean =>
  bot.closeEndedRuns === true || runChatClosesOwed(runtime, bot.id)

/** After a take-and-new run ended, once its chat has been quiet long enough: a look at all the
 *  bot's run chats, so one an earlier look kept (its tab was open, mail unread) is judged again. */
export function scheduleRunChatCheck(runtime: OrcaRuntimeService, sessionId: string): void {
  const timer = setTimeout(() => {
    const bot = botOfSession(runtime.bots, sessionId)
    if (bot && looksAt(runtime, bot)) {
      checkRunChats(runtime, bot)
    }
  }, RUN_CHAT_QUIET_MS + 30_000)
  timer.unref?.()
}

export function bindRunChatChecks(runtime: OrcaRuntimeService): () => void {
  const closingBots = () => runtime.bots.list().filter((bot) => bot.closeEndedRuns === true)
  let on = new Set(closingBots().map((bot) => bot.id))
  const stopListening = runtime.onBotsWritten(() => {
    const now = closingBots()
    now.filter((bot) => !on.has(bot.id)).forEach((bot) => checkRunChats(runtime, bot))
    on = new Set(now.map((bot) => bot.id))
  })
  const afterStart = setTimeout(
    () =>
      runtime.bots
        .list()
        .filter((bot) => looksAt(runtime, bot))
        .forEach((bot) => checkRunChats(runtime, bot)),
    RUN_CHAT_QUIET_MS
  )
  afterStart.unref?.()
  return () => {
    stopListening()
    clearTimeout(afterStart)
  }
}
