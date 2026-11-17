import type { Automation } from '../../shared/automations/automation-definition'
import { automationReceiptFacts } from '../../shared/automations/automation-receipt-facts'
import { botAutomationFacts } from '../../shared/bots/bot-automation-rows'
import { appendOrcaChatCard } from './orca-chat-card'

/** Show what a chat's agent saved in that chat only. Never fails the save. */
export function recordAutomationSavedCard(
  callerSessionId: string | undefined,
  change: 'created' | 'updated',
  automation: Automation,
  effectiveZone?: () => string | undefined
): void {
  if (!callerSessionId) {
    return
  }
  const body = {
    kind: 'automation-saved' as const,
    change,
    receiptFacts: automationReceiptFacts(automation, effectiveZone?.()),
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
