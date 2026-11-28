// A webhook notice as the owner's "couldn't finish" notification shows it.
import type { Automation } from '../../shared/automations/automation-definition'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import { botOwnerNoticeText } from '../bots/bot-owner-notice-copy'

type WebhookNotice = Extract<ConnectorDelivery, { kind: 'webhook_notice' }>

export function webhookNoticeText(
  notice: Pick<WebhookNotice, 'condition' | 'count'>,
  automation: Pick<Automation, 'name'>,
  botName: string
): { title: string; body: string } {
  return {
    title: botOwnerNoticeText('webhookNeedsLook', { bot: botName }),
    body:
      notice.condition === 'refusal_burst'
        ? botOwnerNoticeText('webhookRefusals', {
            automation: automation.name,
            refused: notice.count
          })
        : botOwnerNoticeText('webhookHourlyCap', {
            automation: automation.name,
            limit: notice.count
          })
  }
}
