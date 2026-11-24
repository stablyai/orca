// Dev-only stand-in for Orca Cloud's webhook routes, so a development profile can save a webhook
// automation and show its setup card without a cloud account. Hooks live in memory for the
// process; nothing is reachable from outside and no call is ever delivered or started.
import { randomBytes } from 'node:crypto'
import type { WebhookView } from '../../shared/connector-webhook-routes'
import type { ConnectorFailure, ConnectorResult } from '../connector-cloud/connector-cloud-request'
import type { WebhookCloudCalls } from './webhook-cloud-routes'

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Set to 1 on a development build to use these routes in place of the cloud's. */
export const SYNTHETIC_WEBHOOKS_ENV = 'ORCA_DEV_SYNTHETIC_WEBHOOKS'

function syntheticHookId(): string {
  return `wh_${[...randomBytes(16)].map((byte) => ALPHANUMERIC[byte % ALPHANUMERIC.length]).join('')}`
}

const ok = <T>(value: T): Promise<ConnectorResult<T>> => Promise.resolve({ ok: true, value })
const refused = (status: number, error: string): Promise<ConnectorFailure> =>
  Promise.resolve({ ok: false, status, error, retryAfterMs: null })

export function syntheticWebhookRoutes(): WebhookCloudCalls {
  const hooks = new Map<string, WebhookView>()
  const minted = new Map<string, string>()
  const withHook = <T>(
    hookId: string,
    answer: (hook: WebhookView) => T
  ): Promise<ConnectorResult<T>> => {
    const hook = hooks.get(hookId)
    return hook ? ok(answer(hook)) : refused(404, 'webhook_not_found')
  }
  const update = (hookId: string, change: Partial<WebhookView>): WebhookView => {
    const next = { ...hooks.get(hookId)!, ...change }
    hooks.set(hookId, next)
    return next
  }
  return {
    // Live at once: there is no cloud hello to wait for. A repeated operation mints once.
    mint: ({ operationId, automationId, botId }) => {
      const hookId = minted.get(operationId) ?? syntheticHookId()
      minted.set(operationId, hookId)
      const hook: WebhookView = hooks.get(hookId) ?? {
        hookId,
        automationId,
        botId,
        state: 'live',
        epoch: 1,
        keyGeneration: 1,
        url: `https://webhooks.invalid/hooks/${hookId}`,
        adapter: null,
        previousKeyExpiresAt: null,
        lastCall: null,
        pendingCalls: 0
      }
      hooks.set(hookId, hook)
      return ok(hook)
    },
    list: (botId) => ok({ hooks: [...hooks.values()].filter((hook) => hook.botId === botId) }),
    get: (hookId) => withHook(hookId, (hook) => hook),
    setState: (hookId, { state }) => withHook(hookId, () => update(hookId, { state })),
    remove: (hookId) => withHook(hookId, () => void hooks.delete(hookId)),
    reveal: (hookId) =>
      withHook(hookId, (hook) => ({ key: `synthetic-${hook.keyGeneration}-${hookId.slice(3)}` })),
    rotate: (hookId) =>
      withHook(hookId, (hook) => {
        update(hookId, { keyGeneration: hook.keyGeneration + 1 })
        return { cancelledCalls: 0 }
      }),
    setSecret: (hookId, { adapter, generate }) =>
      withHook(hookId, () => {
        update(hookId, { adapter })
        return generate ? { secret: 'synthetic-signing-secret' } : {}
      }),
    // Nothing is delivered here, so no sample call or run start is ever granted.
    sample: () => refused(503, 'synthetic_webhooks'),
    calls: (hookId) => withHook(hookId, () => ({ calls: [] })),
    envelope: () => refused(404, 'webhook_not_found'),
    start: () => refused(410, 'synthetic_webhooks')
  }
}
