// Sandbox usage ingestion (control plane -> billing) and the Stripe meter outbox.
// Only overage reaches Stripe: included hours are tracked here (Team pools them across seats,
// which tiered Stripe prices cannot express), and the overage price is a flat per-hour metered
// price on a "standard seconds" meter with transform_quantity divide_by=3600.
import { z } from 'zod'
import type { Env } from './env'
import { MACHINE_SIZE_WEIGHT, MACHINE_SIZES, includedSeconds } from './plans'
import type { StripeClient } from './stripe'
import { currentSubscription, customerFor, insertUsage, markMeterReport, pendingMeterReports, usageOverage } from './store'

// One segment is at most a day: the control plane settles running sandboxes periodically.
const MAX_SEGMENT_MS = 24 * 3600 * 1000
// Stripe accepts meter events up to 35 days old and 5 minutes in the future.
const MAX_AGE_MS = 30 * 24 * 3600 * 1000
const FUTURE_SKEW_MS = 5 * 60 * 1000
export const MAX_METER_ATTEMPTS = 10

const ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)

export const UsageReportSchema = z
  .object({
    usageId: ID,
    accountId: ID,
    sandboxId: ID,
    machineSize: z.enum(MACHINE_SIZES),
    startedAt: z.number().int().positive(),
    endedAt: z.number().int().positive()
  })
  .strict()

export type UsageReport = z.infer<typeof UsageReportSchema>

export function validateSegment(report: UsageReport, now: number): string | null {
  if (report.endedAt <= report.startedAt) {
    return 'empty_segment'
  }
  if (report.endedAt - report.startedAt > MAX_SEGMENT_MS) {
    return 'segment_too_long'
  }
  if (report.endedAt > now + FUTURE_SKEW_MS) {
    return 'segment_in_future'
  }
  if (report.endedAt < now - MAX_AGE_MS) {
    return 'segment_too_old'
  }
  return null
}

export async function recordUsage(
  env: Env,
  report: UsageReport,
  now: number
): Promise<{ recorded: boolean; weightedSeconds: number; overageSeconds: number }> {
  const db = env.BILLING_DB
  const subscription = await currentSubscription(db, report.accountId)
  const wallSeconds = Math.ceil((report.endedAt - report.startedAt) / 1000)
  const weightedSeconds = wallSeconds * MACHINE_SIZE_WEIGHT[report.machineSize]
  const billable = subscription !== null && subscription.overage_enabled === 1
  const customer = billable ? await customerFor(db, report.accountId) : null
  const recorded = await insertUsage(db, {
    usageId: report.usageId,
    accountId: report.accountId,
    sandboxId: report.sandboxId,
    machineSize: report.machineSize,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    weightedSeconds,
    periodStart: subscription?.current_period_start ?? null,
    includedSeconds: subscription ? includedSeconds(subscription.plan, subscription.seats) : 0,
    now,
    meterCustomer: customer
  })
  return { recorded, weightedSeconds, overageSeconds: await usageOverage(db, report.usageId) }
}

/** Sends pending meter reports (one usage id, or the oldest batch for the cron). */
export async function flushMeterReports(
  env: Env,
  stripe: StripeClient,
  now: number,
  options: { usageId?: string; limit?: number } = {}
): Promise<{ sent: number; failed: number }> {
  const pending = await pendingMeterReports(env.BILLING_DB, options.limit ?? 100, options.usageId)
  let sent = 0
  let failed = 0
  for (const report of pending) {
    try {
      await stripe.createMeterEvent({
        eventName: env.STRIPE_METER_EVENT_NAME,
        customer: report.stripe_customer_id,
        value: report.seconds,
        identifier: report.usage_id,
        timestamp: report.event_timestamp
      })
      await markMeterReport(env.BILLING_DB, report.usage_id, { sent: true, now })
      sent++
    } catch (error) {
      failed++
      await markMeterReport(env.BILLING_DB, report.usage_id, {
        sent: false,
        error: error instanceof Error ? error.message : 'unknown',
        giveUp: report.attempts + 1 >= MAX_METER_ATTEMPTS
      })
    }
  }
  return { sent, failed }
}
