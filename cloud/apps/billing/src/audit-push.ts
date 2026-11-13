// Billing changes for the team's audit log, which the sandbox control plane owns
// (POST /v1/internal/audit-events, CONTROL_PLANE_TOKEN: that bearer may only write `billing.*`).
// Best effort and bounded: billing's own state is already written, so a failed push loses a log
// line and nothing else. Ids are a stable hash, so the control plane drops a repeat.
import type { Env } from './env'
import type { SubscriptionRow } from './store'

const PUSH_TIMEOUT_MS = 5_000

export type BillingAuditAction =
  | 'billing.plan_started'
  | 'billing.plan_changed'
  | 'billing.plan_canceled'
  | 'billing.cancel_scheduled'
  | 'billing.cancel_reverted'
  | 'billing.seats_changed'
  | 'billing.overage_enabled'
  | 'billing.overage_disabled'
  | 'billing.spend_cap_changed'

export type BillingAuditEvent = {
  action: BillingAuditAction
  at: number
  /** The person who made the change in the desktop; absent for changes Stripe reports. */
  actorUserId?: string
  // Flat and small. No price ids, customer ids or card details: plan, interval, seats, cents.
  detail?: Record<string, string | number | boolean | null>
}

type PushEnv = Pick<Env, 'CONTROL_PLANE_TOKEN' | 'SANDBOX_CONTROL_URL' | 'SANDBOX_CONTROL'>

/** Only teams have an audit log; a personal account's billing changes are its own. */
export function hasTeamAuditLog(accountId: string): boolean {
  return accountId.startsWith('org:') || accountId.startsWith('dev:org:')
}

async function eventId(accountId: string, event: BillingAuditEvent): Promise<string> {
  const text = `${accountId}|${event.action}|${event.at}|${event.actorUserId ?? ''}|${JSON.stringify(event.detail ?? {})}`
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return `billing_${Array.from(bytes.slice(0, 20), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export async function pushBillingAudit(
  env: PushEnv,
  accountId: string,
  events: readonly BillingAuditEvent[],
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const token = (env.CONTROL_PLANE_TOKEN ?? '').split(',')[0]?.trim() ?? ''
  if (!env.SANDBOX_CONTROL_URL || !token || events.length === 0 || !hasTeamAuditLog(accountId)) {
    return false
  }
  // Over the service binding when there is one (same-account workers.dev fetches fail with 1042).
  const send: typeof fetch = env.SANDBOX_CONTROL ? (input, init) => env.SANDBOX_CONTROL!.fetch(input, init) : fetchImpl
  try {
    const response = await send(new URL('/v1/internal/audit-events', env.SANDBOX_CONTROL_URL), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId,
        events: await Promise.all(
          events.slice(0, 50).map(async (event) => ({
            eventId: await eventId(accountId, event),
            action: event.action,
            at: event.at,
            ...(event.actorUserId ? { actorUserId: event.actorUserId } : {}),
            target: { type: 'plan' },
            ...(event.detail ? { detail: event.detail } : {})
          }))
        )
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
    })
    await response.body?.cancel().catch(() => undefined)
    if (!response.ok) {
      console.error(JSON.stringify({ error: 'billing_audit_push', status: response.status }))
      return false
    }
    return true
  } catch (error) {
    console.error(JSON.stringify({ error: 'billing_audit_push', message: error instanceof Error ? error.name : 'unknown' }))
    return false
  }
}

type SubscriptionTerms = Pick<SubscriptionRow, 'status' | 'plan' | 'billing_interval' | 'seats' | 'cancel_at_period_end'>

const ENDED = new Set(['canceled', 'incomplete_expired'])
/** Not a plan yet: Checkout made the subscription but the first payment has not gone through. */
const NOT_STARTED = new Set(['incomplete'])

/**
 * What changed between the stored subscription and the one Stripe now reports, as audit events.
 * A replay of the same Stripe state finds no difference, so it records nothing twice.
 */
export function subscriptionAuditEvents(before: SubscriptionTerms | null, after: SubscriptionTerms, at: number): BillingAuditEvent[] {
  const terms = { plan: after.plan, interval: after.billing_interval, seats: after.seats }
  const wasLive = before !== null && !ENDED.has(before.status) && !NOT_STARTED.has(before.status)
  const isLive = !ENDED.has(after.status) && !NOT_STARTED.has(after.status)
  if (!wasLive) {
    return isLive ? [{ action: 'billing.plan_started', at, detail: terms }] : []
  }
  if (!isLive) {
    return ENDED.has(after.status) ? [{ action: 'billing.plan_canceled', at, detail: { plan: before!.plan } }] : []
  }
  const events: BillingAuditEvent[] = []
  if (before!.plan !== after.plan || before!.billing_interval !== after.billing_interval) {
    events.push({
      action: 'billing.plan_changed',
      at,
      detail: { plan: after.plan, interval: after.billing_interval, previousPlan: before!.plan, previousInterval: before!.billing_interval }
    })
  }
  if (before!.seats !== after.seats) {
    events.push({ action: 'billing.seats_changed', at, detail: { seats: after.seats, previousSeats: before!.seats } })
  }
  if (before!.cancel_at_period_end !== after.cancel_at_period_end) {
    events.push({ action: after.cancel_at_period_end === 1 ? 'billing.cancel_scheduled' : 'billing.cancel_reverted', at })
  }
  return events
}
