// A call the local listener admitted, handed to this host's webhooks as Orca Cloud's trigger delivery
// would be, so the ledger, the call file, the start slots, dedupe and Grace all run as for a cloud call.
import {
  automationWebhookTrigger,
  type AutomationRunEvent
} from '../../../shared/automation-event-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { Bot } from '../../../shared/bot-types'
import type { ConnectorDelivery } from '../../../shared/connectors/connector-cloud-contract'
import { hookIdOfRule, webhookActorId } from '../../../shared/connector-webhook-contract'
import type { WebhookEnvelope } from '../../../shared/connector-webhook-routes'
import { triggerRunEvent } from '../../connector-cloud/connector-triggers'
import type { LocalCall, LocalHook, LocalWebhookStore } from './local-webhook-store'

export type TriggerDelivery = Extract<ConnectorDelivery, { kind: 'trigger' }>

const DAY_MS = 24 * 60 * 60 * 1000
const REDACTED_WEBHOOK_KEY = '[orca webhook key]'

export type LocalWebhookDeliverDeps = {
  store: LocalWebhookStore
  automations: () => readonly Automation[]
  bots: () => readonly Pick<Bot, 'id'>[]
  receive: (delivery: TriggerDelivery, event: AutomationRunEvent) => boolean
  /** A handoff failed: its call stays queued for redeliverQueued, soon. */
  retryLater?: () => void
}

/** The automation that lists the hook's rule here, with that rule. */
export function hookAutomation(automations: readonly Automation[], hook: LocalHook) {
  for (const automation of automations) {
    const rule = automationWebhookTrigger(automation)
    if (rule && hookIdOfRule(rule.id) === hook.hookId && automation.bot?.botId === hook.botId) {
      return { automation, rule }
    }
  }
  return null
}

/** Hands an admitted call to this host's webhooks; refused when no rule here takes it. False when
 *  the handoff failed: the call stays queued and is handed over again. */
export async function deliverLocalCall(
  deps: LocalWebhookDeliverDeps,
  hook: LocalHook,
  call: LocalCall
): Promise<boolean> {
  try {
    await handOver(deps, hook, call)
    return true
  } catch (error) {
    console.warn('[webhooks] a local webhook call could not reach its automation yet', error)
    deps.retryLater?.()
    return false
  }
}

/** Hands every queued call over again; the host takes a call it already has only once. */
export async function redeliverQueued(deps: LocalWebhookDeliverDeps): Promise<void> {
  for (const { hook, call } of await deps.store.queued()) {
    await deliverLocalCall(deps, hook, call)
  }
}

async function handOver(
  deps: LocalWebhookDeliverDeps,
  hook: LocalHook,
  call: LocalCall
): Promise<void> {
  // Checked and handed over in one step of the store's write queue: a call cancelled, a hook removed
  // or paused since the call came in (paused now, or a newer epoch), hands nothing over.
  await deps.store.handOverQueued(call.callId, (live, stored) => {
    const automations = deps.automations()
    const epoch = stored.epoch ?? live.epoch
    const found =
      live.state === 'paused' || epoch !== live.epoch ? null : hookAutomation(automations, live)
    const delivery: TriggerDelivery | null = found && {
      kind: 'trigger',
      deliveryId: stored.callId,
      expiresAt: stored.receivedAt + DAY_MS,
      conversation: { source: 'webhook', externalId: hook.hookId },
      automationId: found.automation.id,
      triggerId: found.rule.id,
      botId: live.botId,
      event: {
        key: stored.callId,
        actorId: webhookActorId(live.hookId),
        ...(stored.subject === undefined ? {} : { subject: stored.subject }),
        occurredAt: stored.receivedAt,
        webhook: {
          callId: stored.callId,
          epoch,
          ...(stored.sample ? { sample: true as const } : {})
        }
      }
    }
    const event = delivery && triggerRunEvent(automations, deps.bots(), delivery)
    return delivery !== null && event !== null && deps.receive(delivery, event)
  })
}

/** The body as a call's envelope keeps it, or null when its JSON doesn't parse. */
export function parseWebhookBody(
  contentType: string | null,
  text: string
): WebhookEnvelope['body'] | null {
  const media = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (text !== '' && (media === 'application/json' || media.endsWith('+json'))) {
    try {
      const value: unknown = JSON.parse(text)
      return { kind: 'json', value }
    } catch {
      return null
    }
  }
  if (media === 'application/x-www-form-urlencoded') {
    // A Map, so names like __proto__ or constructor are ordinary fields; repeats append in place.
    const fields = new Map<string, string[]>()
    for (const [key, entry] of new URLSearchParams(text)) {
      const seen = fields.get(key)
      if (seen) {
        seen.push(entry)
      } else {
        fields.set(key, [entry])
      }
    }
    const value: Record<string, string | string[]> = Object.create(null)
    for (const [key, entries] of fields) {
      value[key] = entries.length === 1 ? (entries[0] ?? '') : entries
    }
    return { kind: 'form', value }
  }
  return { kind: 'text', value: text }
}

/** The value with every one of the keys replaced, in its decoded strings. */
export function withoutKeys<T>(value: T, keys: readonly (string | undefined)[]): T {
  let text = JSON.stringify(value)
  for (const key of keys) {
    // Keys are base64url, so JSON never escapes them: the decoded key appears as it is.
    text = key ? text.split(key).join(REDACTED_WEBHOOK_KEY) : text
  }
  const redacted: T = JSON.parse(text)
  return redacted
}
