// `bot reply` from a run that is in no thread: the refusal names where the run's final message goes,
// so the bot puts its answer there instead of guessing at a channel.
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { runResultsSentence } from '../../shared/automations/automation-results-place'
import { runRoutes, type RunRoute } from '../automations/bot-run-thread-posts'
import { sameSession } from './bot-turn-for'

/** The reply refusal's code; the words a bot acts on ride beside it. */
export const NOT_IN_A_THREAD = 'not_a_cloud_conversation'

export class NotInAThreadError extends Error {
  readonly code = NOT_IN_A_THREAD
}

export type RunReplySources = {
  listAutomationRuns: () => readonly Pick<
    AutomationRun,
    'automationId' | 'chatSessionId' | 'status' | 'trigger'
  >[]
  /** Throws when the automation is gone. */
  showAutomation: (id: string) => Pick<Automation, 'bot'>
  /** The bot whose chat or run the session is; undefined for any other session. */
  botIdOfSession: (sessionId: string) => string | undefined
}

const LIVE = new Set<AutomationRun['status']>(['dispatching', 'dispatched'])

/** The refusal for a chat with no thread to reply in; plain for any chat that isn't a live run's.
 *  It names where this run's final message goes as it was routed, else as the saved automation
 *  would send a run started this way (after a restart). */
export function notInAThread(sources: RunReplySources, sessionId: string | undefined): Error {
  const routed = sessionId ? runRoutes.of(sessionId) : undefined
  const sentence =
    routed && sources.botIdOfSession(sessionId!) === routed.botId
      ? routed.sentence
      : sessionId
        ? liveRunSentence(sources, sessionId)
        : null
  return sentence
    ? new NotInAThreadError(
        `Nothing was posted: this run's conversation isn't in a thread. ${sentence} Put your answer there.`
      )
    : new Error(NOT_IN_A_THREAD)
}

/** Where this live run of the bot's own automation sends its final message, by how it started. */
function liveRunSentence(sources: RunReplySources, sessionId: string): string | null {
  try {
    const run = sources
      .listAutomationRuns()
      .findLast((entry) => entry.chatSessionId === sessionId && LIVE.has(entry.status))
    const target = run && sources.showAutomation(run.automationId).bot
    return target && sources.botIdOfSession(sessionId) === target.botId
      ? runResultsSentence(target, run.trigger)
      : null
  } catch {
    // An unreadable history or a deleted automation: the plain refusal still says what to do.
    return null
  }
}

/** The thread this run posts its result into, as the dispatcher routed it, when the caller is that
 *  run's own chat and the run is its bot's: `bot reply` posts there while it works. */
export function liveRunThreadPost(
  sessionId: string,
  verifiedSessionId: string | undefined,
  botIdOfSession: (sessionId: string) => string | undefined
): (NonNullable<RunRoute['threadPost']> & { botId: string }) | null {
  const route = runRoutes.of(sessionId)
  if (
    !route?.threadPost ||
    verifiedSessionId === undefined ||
    !sameSession(verifiedSessionId, sessionId)
  ) {
    return null
  }
  return botIdOfSession(sessionId) === route.botId
    ? { ...route.threadPost, botId: route.botId }
    : null
}
