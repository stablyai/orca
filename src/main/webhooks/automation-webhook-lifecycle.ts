import type { AutomationService } from '../automations/service'
import type { Store } from '../persistence'
import { normalizeWebhookServerSettings } from '../../shared/webhook-server-settings'
import { WebhookServer } from './webhook-server'

/** The scheduler and listener share one host and one start/stop lifetime. */
export function bindAutomationWebhookLifecycle(service: AutomationService, store: Store): void {
  const server = new WebhookServer({
    getAutomation: (id) => store.listAutomations().find((entry) => entry.id === id),
    triggerWebhook: (id, delivery) => service.triggerWebhook(id, delivery)
  })
  service.getWebhookEndpoint = () => server.getEndpoint()
  let unsubscribe: (() => void) | null = null
  let active = false
  let generation = 0
  let pending = Promise.resolve()
  const apply = (): void => {
    const expected = generation
    pending = pending
      .then(async () => {
        if (active && expected === generation) {
          await server.apply(normalizeWebhookServerSettings(store.getSettings().webhookServer))
          if (!active || expected !== generation) {
            server.stop()
          }
        }
      })
      .catch((error: unknown) => {
        console.error('[webhooks] could not apply receiver settings', error)
      })
  }
  const start = service.start.bind(service)
  const stop = service.stop.bind(service)
  service.start = () => {
    start()
    if (active) {
      return
    }
    active = true
    generation += 1
    unsubscribe = store.onSettingsChanged((updates) => {
      if ('webhookServer' in updates) {
        apply()
      }
    })
    apply()
  }
  service.stop = () => {
    active = false
    generation += 1
    unsubscribe?.()
    unsubscribe = null
    server.stop()
    stop()
  }
}
