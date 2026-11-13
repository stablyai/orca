// Feature entitlements: boolean switches a plan turns on (Enterprise: the team audit log, SSO,
// SCIM, required MFA).
// They gate a surface and nothing else, so they stay out of the Entitlement object: the start
// check, usage metering and the shadow comparison never see them. Resolved from the account's
// live grants in every mode but 'off' (where nothing projects grants, so nothing is on). The
// legacy computation has no features, so there is nothing for shadow mode to compare.
//
//   POST /v1/internal/entitlements/features {accountId}
//     -> { features: { audit_log, sso, scim, mfa_enforcement }, subscribed }
// `subscribed` (hasPaidSubscription) is what auth counts as Orca Cloud access for the account, so a
// paying team is never sent to "Choose a Team plan" because it isn't on the per-account rollout.
// Callers: the control plane (CONTROL_PLANE_TOKEN) and auth (MEMBERSHIP_SYNC_TOKEN). Both fail closed.
import { z } from 'zod'
import { FEATURE_KEYS, type FeatureFlags } from './entitlement-keys'
import { entitlementsMode } from './entitlements-mode'
import type { Env } from './env'
import { LIVE_STATUSES } from './entitlements'
import { grantsForSubject, liveAt } from './grants'
import { currentSubscription } from './store'
import { PAYMENT_FAILED_STATUSES } from './webhook'

export const FeaturesRequestSchema = z.object({ accountId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/) }).strict()

const NONE = Object.fromEntries(FEATURE_KEYS.map((key) => [key, false])) as FeatureFlags

/** A feature is on while any active, in-window grant holds it as true. Held (unpaid) grants do not count. */
export async function featuresFor(env: Pick<Env, 'BILLING_DB' | 'ENTITLEMENTS_MODE'>, accountId: string, now: number): Promise<FeatureFlags> {
  if (entitlementsMode(env) === 'off') {
    return { ...NONE }
  }
  const flags = { ...NONE }
  for (const row of await grantsForSubject(env.BILLING_DB, accountId)) {
    if (row.state !== 'active' || !liveAt(row, now)) {
      continue
    }
    for (const key of FEATURE_KEYS) {
      if (row.entitlement_key === key && row.value_json === 'true') {
        flags[key] = true
      }
    }
  }
  return flags
}

/**
 * Whether the account holds a paid subscription that is live (active, trialing) or in payment
 * recovery (past_due, unpaid): a paying customer, whatever its hours or payment state, whose
 * problems the entitlement itself reports. Canceled, incomplete and expired subscriptions, the
 * no-card trial and no subscription at all are false. Independent of ENTITLEMENTS_MODE: it reads
 * the subscription row Stripe's webhooks keep, as the legacy entitlement does.
 */
export async function hasPaidSubscription(db: D1Database, accountId: string): Promise<boolean> {
  const subscription = await currentSubscription(db, accountId)
  return subscription !== null && (LIVE_STATUSES.has(subscription.status) || PAYMENT_FAILED_STATUSES.has(subscription.status))
}
