// The project's "Composio events" automation: Orca's one address for a Composio project's events.
// It runs nothing itself; the host hands each call to the automation of the bot it's for.
import {
  automationWebhookTrigger,
  EVENT_ONLY_SCHEDULE
} from '../../../../shared/automation-event-triggers'
import type { Bot } from '../../../../shared/bot-types'
import { hookIdOfRule } from '../../../../shared/connector-webhook-contract'
import type { ComposioIngress } from '../../../composio/composio-events-ingress'
import type { OrcaRuntimeService } from '../../orca-runtime'

export const COMPOSIO_INGRESS_NAME = 'Composio events'

export async function createComposioIngress(
  runtime: OrcaRuntimeService,
  bot: Bot
): Promise<ComposioIngress> {
  const automation = await runtime.createAutomation({
    name: COMPOSIO_INGRESS_NAME,
    prompt:
      'Orca hands each Composio event to the automation of the bot it is for. This one only receives them; there is nothing to do.',
    agentId: bot.agent,
    bot: { botId: bot.id, runsIn: 'new', resultsTo: 'none' },
    ...EVENT_ONLY_SCHEDULE,
    on: [{ id: '', source: 'webhook', event: 'call', rev: 0 }]
  })
  const rule = automationWebhookTrigger(automation)
  const hookId = rule ? hookIdOfRule(rule.id) : null
  if (!hookId) {
    throw new Error('Orca couldn’t make the Composio events hook. Try again.')
  }
  return { automationId: automation.id, hookId }
}
