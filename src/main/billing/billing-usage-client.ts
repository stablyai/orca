// GET /v1/billing/usage behind Plan & billing's "Last 30 days". Pure (fetch injected).
import { z } from 'zod'
import type { OrcaBillingUsageHistory } from '../../shared/orca-billing'
import { billingRequest, type BillingEndpoints } from './billing-client'

const UsageId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
const UsageSeconds = z.number().finite().nonnegative()
const usageTop = <K extends 'userId' | 'sandboxId'>(key: K) =>
  z
    .object({
      top: z.array(z.record(z.string(), z.unknown())).max(20),
      otherCount: z.number().int().nonnegative(),
      otherSeconds: UsageSeconds
    })
    .transform((value, ctx) => {
      const top = value.top.map((row) => ({
        id: UsageId.safeParse(row[key]),
        seconds: UsageSeconds.safeParse(row.seconds)
      }))
      if (top.some((row) => !row.id.success || !row.seconds.success)) {
        ctx.addIssue({ code: 'custom', message: 'invalid_usage_row' })
        return z.NEVER
      }
      return {
        top: top.map((row) => ({
          id: row.id.data!,
          seconds: row.seconds.data!
        })),
        otherCount: value.otherCount,
        otherSeconds: value.otherSeconds
      }
    })
    .nullable()
const UsageHistoryBody = z.object({
  days: z.array(z.object({ start: z.number().int(), seconds: UsageSeconds })).max(31),
  totalSeconds: UsageSeconds,
  yourSeconds: UsageSeconds,
  members: usageTop('userId'),
  sandboxes: usageTop('sandboxId')
})

/** GET /v1/billing/usage: 30 days of sandbox hours, days starting at the local midnight. */
export async function fetchUsageHistory(
  endpoints: BillingEndpoints,
  token: string,
  utcOffsetMinutes: number,
  fetchImpl: typeof fetch = fetch
): Promise<OrcaBillingUsageHistory> {
  const body = UsageHistoryBody.safeParse(
    await billingRequest(
      endpoints,
      token,
      'GET',
      `v1/billing/usage?utcOffset=${Math.round(utcOffsetMinutes)}`,
      undefined,
      fetchImpl
    )
  )
  if (!body.success) {
    throw new Error('invalid_billing_response')
  }
  return body.data
}
