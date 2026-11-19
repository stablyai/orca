// The run Orca records on a bot automation run's message, from the same inputs its text is composed from.
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import {
  MAX_AUTOMATION_EVENT_TEXT_LENGTH,
  type AutomationRunEvent
} from '../../shared/automation-event-triggers'
import { onceRunEnding } from '../../shared/automation-once'
import {
  botAutomationFacts,
  type BotAutomationFactsSource
} from '../../shared/bots/bot-automation-rows'
import type {
  AutomationRunMessage,
  AutomationRunMessageEvent
} from '../../shared/automations/automation-run-message'
import type { AutomationEventAsker } from './automation-event-prompt'

function runEvent(
  event: AutomationRunEvent,
  run: Pick<AutomationRun, 'trigger'>,
  asker: AutomationEventAsker | null
): AutomationRunMessageEvent {
  const { source, occurredAt, place, url, actor, text, webhook } = event
  return {
    source,
    event: event.event,
    occurredAt,
    ...(place ? { place } : {}),
    ...(url ? { url } : {}),
    ...(actor ? { actor } : {}),
    // Run now replays the latest event; it never comes by itself.
    ...(run.trigger === 'manual' ? { replayed: true as const } : {}),
    // As automationRunPrompt quotes it.
    ...(text ? { text: text.slice(0, MAX_AUTOMATION_EVENT_TEXT_LENGTH) } : {}),
    ...(text && text.length > MAX_AUTOMATION_EVENT_TEXT_LENGTH
      ? { textShortened: true as const }
      : {}),
    ...(asker ? { asker } : {}),
    ...(webhook
      ? {
          webhook: {
            hookId: webhook.hookId,
            callId: webhook.callId,
            ...(webhook.sample ? { sample: true as const } : {}),
            ...(webhook.firstCall ? { firstCall: true as const } : {})
          }
        }
      : {})
  }
}

/** Undefined when the sent text doesn't start with the saved prompt, so the chat can't show the
 *  instructions apart from the event; it then draws the message as it always has. */
export function captureAutomationRunMessage(
  automation: BotAutomationFactsSource & Pick<Automation, 'prompt'>,
  run: Pick<AutomationRun, 'id' | 'trigger' | 'scheduledFor' | 'event'>,
  text: string,
  asker: AutomationEventAsker | null
): AutomationRunMessage | undefined {
  if (!text.startsWith(automation.prompt)) {
    return undefined
  }
  const wait = onceRunEnding(automation, run)
  return {
    runId: run.id,
    automation: botAutomationFacts(automation),
    trigger: run.trigger,
    ...(run.trigger === 'scheduled' ? { scheduledFor: run.scheduledFor } : {}),
    ...(wait ? { wait } : {}),
    ...(automation.bot?.chat?.toConversation ? { toConversation: true as const } : {}),
    ...(run.event ? { event: runEvent(run.event, run, asker) } : {}),
    instructionsLength: automation.prompt.length
  }
}
