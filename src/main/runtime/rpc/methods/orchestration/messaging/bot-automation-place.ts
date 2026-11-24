// Where an automation run that woke a bot's chat had its event: the thread, issue or pull request,
// read from the run the prompt records.
import { isFinalAutomationRunStatus } from '../../../../../../shared/automations/history/automation-run'
import { isConnectorSource } from '../../../../../../shared/automation-event-triggers'
import type { BotWakingPlace } from '../../../../../bots/bot-request-asker'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { AutomationRunMessage } from '../../../../../../shared/automations/automation-run-message'

/** The automation run in progress in this chat: the one its prompt records, read among that
 *  automation's runs alone; else (an older prompt) the only one in progress. Where its event happened,
 *  never whom the chat acts for, which the conversation's own record says. */
function runningAutomationRun(
  runtime: OrcaRuntimeService,
  sessionId: string,
  recorded?: { automationId: string; runId: string }
) {
  const running = (
    recorded
      ? runtime.listAutomationRuns(recorded.automationId).filter((run) => run.id === recorded.runId)
      : runtime.listAutomationRuns()
  ).filter((run) => run.chatSessionId === sessionId && !isFinalAutomationRunStatus(run.status))
  return running.length === 1 ? running[0] : undefined
}

/** The thread, issue or pull request a running automation run's event happened on. */
export function automationPlace(
  runtime: OrcaRuntimeService,
  sessionId: string,
  recorded: AutomationRunMessage | undefined,
  /** The thread conversation this chat answers, if any. */
  answers: { source: string; externalId: string } | null
): BotWakingPlace | null {
  // A scheduled or manual run's prompt names no event, so no run need be read.
  if (recorded && recorded.trigger !== 'event') {
    return null
  }
  const run = runningAutomationRun(
    runtime,
    sessionId,
    recorded && { automationId: recorded.automation.id, runId: recorded.runId }
  )
  const event = run?.trigger === 'event' ? run.event : undefined
  if (!event?.subject || !isConnectorSource(event.source)) {
    return null
  }
  // A run whose results go to its event's thread answers in that thread's own chat; one that only
  // lands in a chat answering another thread (a "tell me here when…" wait) started nothing there.
  const same = (key: { source: string; externalId: string } | undefined) =>
    key !== undefined &&
    answers !== null &&
    key.source === answers.source &&
    key.externalId === answers.externalId
  const answersThread = same(event.conversation) || same(event.threadOwner?.conversation)
  return {
    source: event.source,
    placeId: event.subject,
    ...(event.url ? { url: event.url } : {}),
    // Results set to none, the bot's Chat or another channel run outside the event's thread's chat.
    ...(answersThread ? {} : { resultsElsewhere: true as const })
  }
}
