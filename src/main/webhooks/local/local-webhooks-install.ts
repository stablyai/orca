// Local webhooks on a host: the listener on its own port, started, moved and stopped with Settings, and
// the routes that stand in for Orca Cloud's while it is on.
import { createServer, type Server } from 'node:http'
import { isIP } from 'node:net'
import type { AutomationRunEvent } from '../../../shared/automation-event-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { Bot } from '../../../shared/bot-types'
import type { ConnectorDelivery } from '../../../shared/connectors/connector-cloud-contract'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { localWebhookConfig } from '../../../shared/webhooks/local-webhook-settings'
import type { WebhookCloudCalls } from '../webhook-cloud-routes'
import {
  deliverLocalCall,
  redeliverQueued,
  type LocalWebhookDeliverDeps
} from './local-webhook-delivery'
import { createLocalWebhookHandler } from './local-webhook-listener'
import { localWebhookCalls } from './local-webhook-routes'
import { LocalWebhookStore } from './local-webhook-store'

type TriggerDelivery = Extract<ConnectorDelivery, { kind: 'trigger' }>

export { LOCAL_WEBHOOKS_ACCOUNT } from '../webhook-host-ledger'

const SETTING_KEYS = [
  'localWebhooksEnabled',
  'localWebhooksBindAddress',
  'localWebhooksPort',
  'localWebhooksPublicUrl'
] as const

const BIND_RETRIES = 10
const BIND_RETRY_MS = 30_000
const REDELIVER_MS = 60_000

export type LocalWebhooks = {
  /** The local routes while local webhooks are on; null hands webhooks to Orca Cloud. */
  routes: () => WebhookCloudCalls | null
  /** Where admitted calls go: the host's webhooks, once made. */
  attach: (receive: (delivery: TriggerDelivery, event: AutomationRunEvent) => boolean) => void
  stop: () => void
}

export function installLocalWebhooks(deps: {
  userDataPath: string
  settings: () => Partial<GlobalSettings>
  onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => () => void
  automations: () => readonly Automation[]
  bots: () => readonly Pick<Bot, 'id'>[]
  /** Local webhooks went on or off, so the hooks and the hello change. */
  modeChanged: () => void
  /** For tests: the wait before a busy port is tried again. */
  bindRetryMs?: number
  /** For tests: the wait before calls whose handoff failed go again. */
  redeliverMs?: number
}): LocalWebhooks {
  const store = new LocalWebhookStore(deps.userDataPath)
  let receive: (delivery: TriggerDelivery, event: AutomationRunEvent) => boolean = () => false
  const config = () => localWebhookConfig(deps.settings())
  let retry: NodeJS.Timeout | null = null
  let stopped = false
  // Calls taken but not handed over (a failed handoff, or Orca quit first) go again while on.
  const redeliver = (): void => {
    if (config() && !stopped) {
      redeliverQueued(deliverDeps).catch((error: unknown) => {
        console.warn('[webhooks] the queued local webhook calls could not be read', error)
        deliverDeps.retryLater?.()
      })
    }
  }
  const deliverDeps: LocalWebhookDeliverDeps = {
    store,
    automations: deps.automations,
    bots: deps.bots,
    // Turned off during a pass: the handoff fails, so its call stays queued for when it is on again.
    receive: (delivery, event) => {
      if (!config()) {
        throw new Error('local webhooks are off')
      }
      return receive(delivery, event)
    },
    retryLater: () => {
      if (stopped) {
        return
      }
      retry ??= setTimeout(() => {
        retry = null
        redeliver()
      }, deps.redeliverMs ?? REDELIVER_MS)
      retry.unref()
    }
  }
  const routes = localWebhookCalls({
    store,
    baseUrl: () => config()?.baseUrl ?? 'http://127.0.0.1',
    deliver: (hook, call) => deliverLocalCall(deliverDeps, hook, call)
  })
  const handler = createLocalWebhookHandler(deliverDeps)

  let server: Server | null = null
  let listening: string | null = null
  let bindRetries = 0
  // Off or moved: open keep-alive connections end too, so nothing is served on the old address.
  const close = (): void => {
    server?.close()
    server?.closeAllConnections()
    server = null
  }
  const apply = (): void => {
    if (stopped) {
      return
    }
    const next = config()
    if (next && isIP(next.bindAddress) === 0) {
      console.warn(
        `[webhooks] local webhooks can't listen on ${next.bindAddress}: not an IP address`
      )
    }
    const wanted = next && isIP(next.bindAddress) !== 0 ? `${next.bindAddress}|${next.port}` : null
    if (wanted === listening) {
      return
    }
    close()
    listening = wanted
    if (next && wanted) {
      const made = createServer(handler)
      // A slow sender can't hold a connection open for long.
      made.requestTimeout = 30_000
      made.headersTimeout = 10_000
      made.on('error', (error) => {
        console.warn(
          `[webhooks] local webhooks could not listen on ${next.bindAddress}:${next.port}`,
          error
        )
        // A busy port may free up: try the same address again a few times, then wait for Settings.
        if (server === made && !made.listening) {
          close()
          listening = null
          if (bindRetries < BIND_RETRIES) {
            bindRetries++
            setTimeout(apply, deps.bindRetryMs ?? BIND_RETRY_MS).unref()
          }
        }
      })
      made.on('listening', () => {
        bindRetries = 0
      })
      made.listen(next.port, next.bindAddress)
      server = made
    }
  }

  let on = config() !== null
  apply()
  const unsubscribe = deps.onSettingsChanged((updates) => {
    if (!SETTING_KEYS.some((key) => key in updates)) {
      return
    }
    bindRetries = 0
    apply()
    if ((config() !== null) !== on) {
      on = !on
      deps.modeChanged()
      redeliver()
    }
  })
  return {
    routes: () => (config() ? routes : null),
    attach: (next) => {
      receive = next
      redeliver()
    },
    stop: () => {
      stopped = true
      // A handoff still running fails, so no run starts after this and its call stays queued.
      receive = () => {
        throw new Error('local webhooks stopped')
      }
      if (retry) {
        clearTimeout(retry)
      }
      unsubscribe()
      close()
      listening = null
    }
  }
}
