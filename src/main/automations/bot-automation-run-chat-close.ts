// When a bot automation's finished run chat goes on the close list: its run started a new
// conversation, and its result doesn't go back to a thread or issue that hears from it again.
import type {
  Automation,
  AutomationBotResultsTo
} from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { observeAutomationChatRun } from './observation/runtime-chat-run-observer'
import type { AutomationRunCompletionObservation } from './observation/run-completion-watcher'

export const runChatClosesWhenFinished = (resultsTo: AutomationBotResultsTo): boolean =>
  resultsTo !== 'thread' && !(typeof resultsTo === 'object' && 'linearIssue' in resultsTo)

/** A chat run's result. A bot run Orca reattached after a restart lost the launch that would put
 *  its chat on the close list, so it goes on here once the run ends. */
export async function observeAutomationRunChat(
  runtime: OrcaRuntimeService,
  automation: Automation | undefined,
  run: AutomationRun,
  signal: AbortSignal
): Promise<AutomationRunCompletionObservation> {
  const observed = await observeAutomationChatRun(runtime, run, signal, Boolean(automation?.bot))
  const target = automation?.bot
  const bot = target && runtime.bots.list().find((entry) => entry.id === target.botId)
  if (
    bot &&
    run.chatSessionId &&
    target.runsIn === 'new' &&
    runChatClosesWhenFinished(target.resultsTo)
  ) {
    runtime.botRunChatCloser?.arm(bot, run.chatSessionId)
  }
  return observed
}
