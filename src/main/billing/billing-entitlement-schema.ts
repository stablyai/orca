// The billing service's entitlement body as the desktop reads it: lenient by design, so a newer
// service (new plans, reasons or fields) degrades gracefully instead of breaking an older desktop.
import { z } from 'zod'
import type { OrcaBillingEntitlement } from '../../shared/orca-billing'
import { ORCA_BILLING_INTERVALS } from '../../shared/orca-billing'

const seconds = z.number().catch(0)
const window = z.object({ start: z.number(), end: z.number() }).nullable().catch(null)

const OffersSchema = z
  .object({
    team: z.object({
      label: z.string().max(40),
      monthlyPriceLabel: z.string().max(40),
      annualPriceLabel: z.string().max(40),
      monthlyPriceCentsPerSeat: z.number().int().nonnegative().nullable().catch(null),
      annualPriceCentsPerSeat: z.number().int().nonnegative().nullable().catch(null),
      largeMachineWeight: z.number().positive().catch(1),
      includedHoursPerSeat: z.number().nonnegative(),
      concurrentSandboxesPerSeat: z.number().int().nonnegative(),
      idleSleepMinutes: z.number().int().positive(),
      overageCentsPerHour: z.number().int().positive(),
      defaultSpendCapCents: z.number().int().nonnegative(),
      maxSpendCapCents: z.number().int().positive().nullable().catch(null),
      warnAtPercent: z
        .array(z.number().int().min(1).max(100))
        .max(10)
        .nullable()
        .optional()
        .catch(null)
        .transform((value) => value ?? null)
    }),
    enterprise: z.object({
      label: z.string().max(40),
      priceLabel: z.string().max(40),
      // Opened in the browser: https only.
      contactUrl: z.string().url().startsWith('https://')
    }),
    // Absent from older services: no trial on offer.
    trial: z
      .object({ includedSeconds: z.number().nonnegative() })
      .nullable()
      .optional()
      .catch(null)
      .transform((value) => value ?? null)
  })
  .nullable()
  .catch(null)

// Lenient by design: an unknown plan/reason or a missing field degrades to "none"/0, never an error,
// so a newer billing service cannot break an older desktop.
const EntitlementSchema = z.object({
  // Any plan id: a newer service's plan must still read as a plan, not as "no plan".
  plan: z.string().min(1).max(40).nullable().catch(null),
  planLabel: z.string().nullable().catch(null),
  status: z.string().catch('none'),
  interval: z.enum(ORCA_BILLING_INTERVALS).nullable().catch(null),
  seats: seconds,
  seatChange: z
    .object({
      seatsAtRenewal: z.number().int().min(1),
      effectiveAt: z.number()
    })
    .nullable()
    .catch(null),
  period: window,
  usageWindow: window,
  cancelAtPeriodEnd: z.boolean().catch(false),
  // When a cancelling plan ends (Stripe's cancel_at); older services omit it: the period end.
  cancelAt: z.number().nullable().optional().catch(null).transform((value) => value ?? null),
  trial: z
    .object({
      includedSeconds: z.number().nonnegative(),
      usedSeconds: z.number().nonnegative(),
      remainingSeconds: z.number().nonnegative(),
      exhausted: z.boolean(),
      grantedAt: z.number()
    })
    .nullable()
    .optional()
    .catch(null)
    .transform((value) => value ?? null),
  includedSeconds: seconds,
  usedSeconds: seconds,
  remainingIncludedSeconds: seconds,
  usageWarningPercent: z.number().nullable().catch(null),
  overageSeconds: seconds,
  overage: z
    .object({
      optedIn: z.boolean().catch(false),
      active: z.boolean().catch(false),
      spendCapCents: seconds,
      spentCents: seconds,
      centsPerHour: seconds
    })
    .catch({
      optedIn: false,
      active: false,
      spendCapCents: 0,
      spentCents: 0,
      centsPerHour: 0
    }),
  payment: z
    .object({
      pastDueSince: z.number().nullable().catch(null),
      graceEndsAt: z.number().nullable().catch(null),
      suspendRunning: z.boolean().catch(false)
    })
    .catch({ pastDueSince: null, graceEndsAt: null, suspendRunning: false }),
  limits: z
    .object({
      maxConcurrentSandboxes: z.number().int().nonnegative(),
      maxConcurrentSandboxesPerMember: z.number().int().nonnegative()
    })
    .nullable()
    .optional()
    .catch(null)
    .transform((value) => value ?? null),
  canStartSandbox: z.boolean().catch(false),
  reason: z
    .enum([
      'no_subscription',
      'subscription_inactive',
      'payment_past_due',
      'payment_grace_expired',
      'included_hours_exhausted',
      'overage_cap_reached',
      'trial_used_up',
      'trial_unavailable'
    ])
    .nullable()
    .catch(null),
  canManageBilling: z.boolean().catch(false),
  offers: OffersSchema.optional().transform((value) => value ?? null)
})

export function normalizeEntitlement(value: Record<string, unknown>): OrcaBillingEntitlement {
  return EntitlementSchema.parse(value)
}
