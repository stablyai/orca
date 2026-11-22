// A webhook notice as the owner's "couldn't finish" notification shows it.
import type { Automation } from '../../shared/automations/automation-definition'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'

type WebhookNotice = Extract<ConnectorDelivery, { kind: 'webhook_notice' }>

export function webhookNoticeText(
  notice: Pick<WebhookNotice, 'condition' | 'count'>,
  automation: Pick<Automation, 'name'>,
  botName: string
): { title: string; body: string } {
  return {
    title: `${botName}'s webhook needs a look`,
    body:
      notice.condition === 'refusal_burst'
        ? `"${automation.name}" refused ${notice.count} calls in the last 10 minutes. If you don't expect them, pause it.`
        : `"${automation.name}" reached its ${notice.count} runs an hour; more calls wait. To stop them, pause it.`
  }
}
