// Where an automation run that woke a bot's chat had its event: the thread, issue or pull request,
// read from the run the prompt records.
import { isFinalAutomationRunStatus } from '../../../../../../shared/automations/history/automation-run'
import { isConnectorSource } from '../../../../../../shared/automation-event-triggers'
import type { BotWakingPlace } from '../../../../../bots/bot-request-asker'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

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
  recorded?: { automationId: string; runId: string }
): BotWakingPlace | null {
  const run = runningAutomationRun(runtime, sessionId, recorded)
  const event = run?.trigger === 'event' ? run.event : undefined
  if (!run || !event?.subject || !isConnectorSource(event.source)) {
    return null
  }
  return {
    source: event.source,
    placeId: event.subject,
    ...(event.url ? { url: event.url } : {}),
    ...(resultsToThread(runtime, run.automationId) ? { resultsHere: true as const } : {})
  }
}

/** Whether an automation posts its runs' results back to their event's thread. */
function resultsToThread(runtime: OrcaRuntimeService, automationId: string): boolean {
  try {
    return runtime.showAutomation(automationId).bot?.resultsTo === 'thread'
  } catch {
    return false
  }
}
