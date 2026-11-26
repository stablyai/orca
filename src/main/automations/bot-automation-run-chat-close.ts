// A bot run Orca reattached after a restart lost the launch that would put its chat on the close
// list, so its observation does it once the run ends.
import type { Automation } from '../../shared/automations/automation-definition'
import { runChatClosesWhenFinished } from '../../shared/automation-bot-target'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { observeAutomationChatRun } from './observation/runtime-chat-run-observer'
import type { AutomationRunCompletionObservation } from './observation/run-completion-watcher'

/** A chat run's result; a bot run's own new conversation then goes on the close list. */
export async function observeAutomationRunChat(
  runtime: OrcaRuntimeService,
  automation: Automation | undefined,
  run: AutomationRun,
  signal: AbortSignal
): Promise<AutomationRunCompletionObservation> {
  const observed = await observeAutomationChatRun(runtime, run, signal, Boolean(automation?.bot))
  const target = automation?.bot
  const bot = target && runtime.bots.list().find((entry) => entry.id === target.botId)
  const chat = run.chatSessionId
  if (bot && chat && target.runsIn === 'new' && runChatClosesWhenFinished(target.resultsTo)) {
    // Only a chat this run made: one older than the run is a chat it continued, whatever the
    // automation says now.
    const made = (await runtime.openAgentSessionRecordStore()).getConversation(chat)?.createdAt
    if (made !== undefined && made >= run.createdAt) {
      runtime.botRunChatCloser?.arm(bot, chat)
    }
  }
  return observed
}
