// `bot reply` from a run that is in no thread: the refusal names where the run's final message goes,
// so the bot puts its answer there instead of guessing at a channel.
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { automationResultsSentence } from '../../shared/automations/automation-results-place'

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

function runResultsSentence(sources: RunReplySources, sessionId: string): string | null {
  try {
    const run = sources
      .listAutomationRuns()
      .findLast((entry) => entry.chatSessionId === sessionId && LIVE.has(entry.status))
    const target = run && sources.showAutomation(run.automationId).bot
    return target ? automationResultsSentence(target) : null
  } catch {
    // An unreadable history or a deleted automation: the plain refusal still says what to do.
    return null
  }
}
