// The catalog and an account's entitlements as clients read them:
//   GET /v1/plans         public plan catalog: prices (Stripe's), entitlements, features, policy
//   GET /v1/entitlements  the caller's effective entitlements, access, and the grants behind them
// plus `offers`, the older shape inside GET /v1/billing/entitlements and the setup pages, built
// from the same catalog when ENTITLEMENTS_MODE is on (from plans.ts otherwise).
import { checkoutPrice } from './catalog-sync'
import { defaultSelfServePlan, loadCatalog, planVersion, policyFor, type Catalog, type CatalogPlan } from './catalog'
import { catalogOverageCentsPerHour, computeEntitlement, entitlementsMode, type Entitlement } from './entitlements'
import type { Env } from './env'
import { featuresFor } from './features'
import { grantsForSubject, liveAt } from './grants'
import { MACHINE_SIZE_WEIGHT, planCatalog, publicOffers, type BillingInterval } from './plans'

export const PLANS_SCHEMA_VERSION = 1

/** "$50", "$480", "$12.50": whole units without decimals, like the legacy labels. */
export function formatPrice(cents: number, currency: string): string {
  const whole = cents % 100 === 0
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2
  }).format(cents / 100)
}

function seatPrice(catalog: Catalog, plan: CatalogPlan, interval: BillingInterval) {
  const row = checkoutPrice(catalog, plan.id, interval)
  return row && typeof row.unit_amount === 'number' ? { cents: row.unit_amount, currency: row.currency ?? 'usd' } : null
}

function perSeatValue(plan: CatalogPlan, key: 'sandbox_hours_monthly' | 'max_concurrent_sandboxes'): number {
  const entry = planVersion(plan, plan.currentVersion).entitlements[key]
  return typeof entry?.value === 'number' ? entry.value : 0
}

/** The legacy `offers` shape, from the D1 catalog and Stripe's prices. A missing price is null/''. */
export function catalogOffers(catalog: Catalog, idleSleepMinutes: number) {
  const team = defaultSelfServePlan(catalog)
  const policy = policyFor(catalog, team, team.currentVersion)
  const monthly = seatPrice(catalog, team, 'month')
  const annual = seatPrice(catalog, team, 'year')
  const enterprise = [...catalog.plans.values()].find((plan) => plan.kind === 'contact_sales' && plan.public)
  return {
    team: {
      label: team.name,
      monthlyPriceLabel: monthly ? `${formatPrice(monthly.cents, monthly.currency)} per seat per month` : '',
      annualPriceLabel: annual ? `${formatPrice(annual.cents, annual.currency)} per seat, billed yearly` : '',
      monthlyPriceCentsPerSeat: monthly?.cents ?? null,
      annualPriceCentsPerSeat: annual?.cents ?? null,
      largeMachineWeight: MACHINE_SIZE_WEIGHT.large,
      includedHoursPerSeat: perSeatValue(team, 'sandbox_hours_monthly'),
      concurrentSandboxesPerSeat: perSeatValue(team, 'max_concurrent_sandboxes'),
      idleSleepMinutes,
      overageCentsPerHour: catalogOverageCentsPerHour(catalog, team.id),
      defaultSpendCapCents: policy.overage.defaultSpendCapCents,
      maxSpendCapCents: policy.overage.maxSpendCapCents,
      // Additive (older desktops ignore it): the levels owners and admins are alerted at.
      warnAtPercent: policy.warnAtPercent
    },
    enterprise: enterprise
      ? { label: enterprise.name, priceLabel: enterprise.config.priceLabel ?? '', contactUrl: enterprise.config.contactUrl ?? '' }
      : { label: '', priceLabel: '', contactUrl: '' }
  }
}

/** `offers` for the desktop and the setup pages, from whichever catalog the mode serves. */
export async function offersFor(env: Env, now: number) {
  if (entitlementsMode(env) !== 'on') {
    return publicOffers(planCatalog(env))
  }
  return catalogOffers(await loadCatalog(env.BILLING_DB, now), planCatalog(env).team.idleSleepMinutes)
}

/** GET /v1/plans: the public catalog. Prices only ever come from Stripe (no price, no checkout). */
export function plansView(catalog: Catalog) {
  const plans = [...catalog.plans.values()]
    .filter((plan) => plan.public)
    .sort((a, b) => a.sort - b.sort)
    .map((plan) => {
      const version = planVersion(plan, plan.currentVersion)
      const base = {
        id: plan.id,
        kind: plan.kind,
        name: plan.name,
        version: plan.currentVersion,
        entitlements: version.entitlements,
        features: version.features,
        // "Contact us" for this plan (https: or mailto:); clients fall back to Enterprise's contact.
        supportUrl: plan.config.supportUrl ?? null
      }
      if (plan.kind === 'contact_sales') {
        return { ...base, contactUrl: plan.config.contactUrl ?? null, priceLabel: plan.config.priceLabel ?? null }
      }
      if (plan.kind !== 'self_serve') {
        return base
      }
      const policy = policyFor(catalog, plan, plan.currentVersion)
      const prices = (['month', 'year'] as const).flatMap((interval) => {
        const price = seatPrice(catalog, plan, interval)
        return price ? [{ interval, unitAmountCents: price.cents, currency: price.currency }] : []
      })
      return {
        ...base,
        billing: 'per_seat' as const,
        prices,
        overage: {
          centsPerHour: catalogOverageCentsPerHour(catalog, plan.id),
          billedPer: 'minute' as const,
          defaultSpendCapCents: policy.overage.defaultSpendCapCents,
          maxSpendCapCents: policy.overage.maxSpendCapCents
        },
        seats: policy.seats,
        warnAtPercent: policy.warnAtPercent,
        checkout: { available: prices.length > 0, intervals: prices.map((price) => price.interval) }
      }
    })
  return { schemaVersion: PLANS_SCHEMA_VERSION, catalogVersion: catalog.etag.replaceAll('"', ''), plans }
}

/** GET /v1/entitlements: effective values (the mode's resolver), access, and the live grants. */
export async function entitlementsView(env: Env, accountId: string, canManageBilling: boolean, now: number) {
  const entitlement: Entitlement = await computeEntitlement(env, accountId, now, 'entitlements_v1')
  const mode = entitlementsMode(env)
  const grants = mode === 'off' ? [] : (await grantsForSubject(env.BILLING_DB, accountId)).filter((row) => liveAt(row, now) || row.state === 'held')
  return {
    schemaVersion: PLANS_SCHEMA_VERSION,
    subject: accountId,
    asOf: now,
    source: mode === 'on' ? 'grants' : 'legacy',
    plan: entitlement.plan
      ? {
          id: entitlement.plan,
          name: entitlement.planLabel,
          status: entitlement.status,
          interval: entitlement.interval,
          seats: entitlement.seats,
          period: entitlement.period,
          cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
          cancelAt: entitlement.cancelAt
        }
      : null,
    trial: entitlement.trial,
    effective: {
      sandboxSeconds: {
        included: entitlement.includedSeconds,
        used: entitlement.usedSeconds,
        remaining: entitlement.remainingIncludedSeconds,
        window: entitlement.usageWindow,
        resets: entitlement.trial ? 'never' : entitlement.usageWindow ? 'monthly' : null
      },
      maxConcurrentSandboxes: entitlement.limits.maxConcurrentSandboxes,
      maxConcurrentSandboxesPerMember: entitlement.limits.maxConcurrentSandboxesPerMember,
      machineSizes: entitlement.limits.machineSizes,
      overage: entitlement.overage,
      overageSeconds: entitlement.overageSeconds,
      usageWarningPercent: entitlement.usageWarningPercent,
      // Additive: plan features (Enterprise). Who may use each one is the owning service's call.
      features: await featuresFor(env, accountId, now)
    },
    access: { canStartSandbox: entitlement.canStartSandbox, reason: entitlement.reason, suspendRunning: entitlement.suspendRunning },
    payment: { pastDueSince: entitlement.payment.pastDueSince, graceEndsAt: entitlement.payment.graceEndsAt },
    grants: grants.map((row) => ({
      key: row.entitlement_key,
      value: JSON.parse(row.value_json) as unknown,
      perSeat: row.per_seat === 1,
      seats: row.seat_quantity,
      source: row.source_type,
      state: row.state,
      ...(row.hold_reason ? { holdReason: row.hold_reason } : {}),
      // Ad hoc manual and promo grants carry the placeholder plan 'manual'; a contact-sales plan granted by ops names itself.
      plan: row.plan_id && row.plan_id !== 'manual' ? { id: row.plan_id, version: row.plan_version } : null,
      startsAt: row.starts_at,
      endsAt: row.ends_at
    })),
    canManageBilling
  }
}
