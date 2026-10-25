import { isWebhookTriggerEnabled } from '../../shared/automation-webhook'
import type { Automation } from '../../shared/automations-types'
import type { Store } from '../persistence'
import { captureLegacyRunTarget } from './run-target-resolution'

export function getWebhookAutomationForDispatch(
  store: Store,
  automationId: string,
  allowRemoteHostScheduling: boolean
): Automation {
  const automation = store.listAutomations().find((entry) => entry.id === automationId)
  if (!automation) {
    throw new Error('Automation not found.')
  }
  if (!isWebhookTriggerEnabled(automation)) {
    throw new Error('Webhook trigger is not enabled for this automation.')
  }
  return captureLegacyRunTarget(store, automation, allowRemoteHostScheduling)
}
