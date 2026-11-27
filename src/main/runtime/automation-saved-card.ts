import type { Automation } from '../../shared/automations/automation-definition'
import { botAutomationFacts } from '../../shared/bots/bot-automation-rows'
import { appendOrcaChatCard } from './orca-chat-card'

/** Show what a chat's agent saved in that chat only. Never fails the save. */
export function recordAutomationSavedCard(
  callerSessionId: string | undefined,
  change: 'created' | 'updated',
  automation: Automation
): void {
  const body = {
    kind: 'automation-saved' as const,
    change,
    automation: botAutomationFacts(automation),
    ...(automation.bot ? { resultsTo: automation.bot.resultsTo } : {}),
    ...(automation.bot?.runsIn === 'new' && automation.bot.agentSetup
      ? { agentSetup: automation.bot.agentSetup }
      : {})
  }
  if (callerSessionId) {
    appendOrcaChatCard(callerSessionId, body, 'showing a saved automation in its chat')
  }
}
