// `bot reply` from a run that is in no thread: the refusal names where the run's final message goes,
// so the bot puts its answer there instead of guessing at a channel.
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import {
  automationResultsSentence,
  originThreadText
} from '../../shared/automations/automation-results-place'
import type { ConversationKey } from '../external-conversations/external-conversation-types'

/** The reply refusal's code; the words a bot acts on ride beside it. */
export const NOT_IN_A_THREAD = 'not_a_cloud_conversation'

export class NotInAThreadError extends Error {
  readonly code = NOT_IN_A_THREAD
}

export type RunReplySources = {
  listAutomationRuns: () => readonly Pick<
    AutomationRun,
    'automationId' | 'chatSessionId' | 'status'
  >[]
  /** Throws when the automation is gone. */
  showAutomation: (id: string) => Pick<Automation, 'bot'>
  /** The bot whose chat or run the session is; undefined for any other session. */
  botIdOfSession: (sessionId: string) => string | undefined
}

const LIVE = new Set<AutomationRun['status']>(['dispatching', 'dispatched'])

/** The refusal for a chat with no thread to reply in; plain for any chat that isn't a live run's. */
export function notInAThread(sources: RunReplySources, sessionId: string | undefined): Error {
  const sentence = sessionId ? runResultsSentence(sources, sessionId) : null
  return sentence
    ? new NotInAThreadError(
        `Nothing was posted: this run's conversation isn't in a thread. ${sentence} Put your answer there.`
      )
    : new Error(NOT_IN_A_THREAD)
}

/** The bot target of the live run this session is, when the session is the bot's own. */
function liveRunTarget(sources: RunReplySources, sessionId: string) {
  try {
    const run = sources
      .listAutomationRuns()
      .findLast((entry) => entry.chatSessionId === sessionId && LIVE.has(entry.status))
    const target = run && sources.showAutomation(run.automationId).bot
    return target && sources.botIdOfSession(sessionId) === target.botId ? target : null
  } catch {
    // An unreadable history or a deleted automation: the plain refusal still says what to do.
    return null
  }
}

function runResultsSentence(sources: RunReplySources, sessionId: string): string | null {
  const target = liveRunTarget(sources, sessionId)
  return target ? automationResultsSentence(target) : null
}

/** The thread a run outside the chat that answers it posts its result into: `bot reply` posts
 *  there too while it works. Null for any other session. */
export function runOriginThread(
  sources: RunReplySources,
  sessionId: string
): { key: ConversationKey; place: string } | null {
  const target = liveRunTarget(sources, sessionId)
  const origin = target?.originThread
  // Its own agent or another chat posts into the thread; so does a new conversation whose thread's
  // chat was gone when it started.
  const answersThere =
    target?.resultsTo === 'thread' ||
    (target?.runsIn === 'chat' && target.chat?.sessionId === origin?.sessionId)
  return origin && answersThere
    ? {
        key: { source: origin.source, externalId: origin.externalId },
        place: originThreadText(origin)
      }
    : null
}
