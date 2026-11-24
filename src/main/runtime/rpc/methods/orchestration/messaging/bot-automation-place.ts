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
  /** The chat answers its event's thread, which a run whose results go there runs in. */
  answersThread: boolean
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
  return {
    source: event.source,
    placeId: event.subject,
    ...(event.url ? { url: event.url } : {}),
    // Results set to none, the bot's Chat or another channel run outside the thread's chat.
    ...(answersThread ? {} : { resultsElsewhere: true as const })
  }
}

/** Where the running turn's own prompt says its event happened, from its record alone (no run is
 *  read); none for a prompt from a host that recorded no event link. */
export function recordedAutomationPlace(
  recorded: AutomationRunMessage | undefined,
  answersThread: boolean
): BotWakingPlace | null {
  const event = recorded?.trigger === 'event' ? recorded.event : undefined
  if (!event?.url || !isConnectorSource(event.source)) {
    return null
  }
  return {
    source: event.source,
    placeId: event.place ?? event.url,
    url: event.url,
    ...(answersThread ? {} : { resultsElsewhere: true as const })
  }
}
