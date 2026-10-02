import { createHash } from 'node:crypto'
import { net, session } from 'electron'
import { z } from 'zod'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  estimateSyntheticQuotaRechargeAt,
  getSyntheticRequestRefillPercent,
  getSyntheticCreditRefillPercent
} from './synthetic-quota-recharge'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'

export const SYNTHETIC_QUOTAS_URL = 'https://api.synthetic.new/v2/quotas'
// Synthetic documents the refill cadence at https://synthetic.new/rate-limits.
const REQUEST_REFILL_INTERVAL_MS = 15 * 60_000
const CREDIT_REFILL_INTERVAL_MS = 202 * 60_000
const quotaSchema = z.object({
  rollingFiveHourLimit: z
    .object({
      nextTickAt: z.string().datetime({ offset: true }).nullish(),
      remaining: z.number().finite().nonnegative(),
      max: z.number().finite().nonnegative(),
      tickPercent: z.unknown().optional()
    })
    .nullish(),
  weeklyTokenLimit: z
    .object({
      percentRemaining: z.number().finite().min(0).max(100),
      nextRegenAt: z.string().datetime({ offset: true }).nullish(),
      maxCredits: z.unknown().optional(),
      nextRegenCredits: z.unknown().optional()
    })
    .nullish(),
  subscription: z.object({
    limit: z.number().finite().nonnegative(),
    requests: z.number().finite().nonnegative(),
    renewsAt: z.string().datetime({ offset: true })
  })
})

export async function fetchSyntheticRateLimits(
  configuredApiKey: string,
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  const apiKey = configuredApiKey.trim() || process.env.SYNTHETIC_API_KEY?.trim() || ''
  const base: ProviderRateLimits = {
    provider: 'synthetic',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'unavailable',
    usageMetadata: {
      source: 'web',
      authProvenance: createHash('sha256').update(apiKey).digest('hex')
    }
  }
  if (!apiKey) {
    return { ...base, error: 'Synthetic API key not configured' }
  }
  try {
    await ensureElectronProxyFromEnvironment({
      proxySession: session.defaultSession,
      probeUrl: SYNTHETIC_QUOTAS_URL
    }).catch(() => {})
    const timeout = AbortSignal.timeout(15_000)
    const response = await net.fetch(SYNTHETIC_QUOTAS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      // Never forward the key to a redirect target.
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    if (!response.ok) {
      return {
        ...base,
        status: 'error',
        error:
          response.status === 401 || response.status === 403
            ? 'Synthetic API key rejected — check your API key'
            : `Synthetic quota request failed (${response.status})`
      }
    }
    const parsed = quotaSchema.safeParse(await response.json())
    if (!parsed.success) {
      return { ...base, status: 'error', error: 'Could not parse Synthetic quota response' }
    }
    const { subscription, rollingFiveHourLimit: rolling, weeklyTokenLimit: weekly } = parsed.data
    const requests =
      Math.round(
        (rolling ? Math.max(0, rolling.max - rolling.remaining) : subscription.requests) * 100
      ) / 100
    const limit = rolling ? rolling.max : subscription.limit
    const resetsAt = !rolling && requests > 0 ? Date.parse(subscription.renewsAt) : null
    const usedPercent = limit > 0 ? Math.min(100, (requests / limit) * 100) : requests > 0 ? 100 : 0
    const requestRefillAt =
      rolling?.nextTickAt && requests > 0 ? Date.parse(rolling.nextTickAt) : null
    const weeklyRefillAt =
      weekly && weekly.percentRemaining < 100 && weekly.nextRegenAt
        ? Date.parse(weekly.nextRegenAt)
        : null
    return {
      ...base,
      status: 'ok',
      updatedAt: Date.now(),
      requestQuota: { requests, limit, renewsAt: resetsAt },
      session: {
        usedPercent,
        windowMinutes: 300,
        resetsAt,
        refillsAt: requestRefillAt,
        rechargesAt: estimateSyntheticQuotaRechargeAt({
          usedPercent,
          nextRefillAt: requestRefillAt,
          refillPercent: getSyntheticRequestRefillPercent(rolling?.tickPercent),
          intervalMs: REQUEST_REFILL_INTERVAL_MS
        }),
        resetDescription: null
      },
      weekly: weekly
        ? {
            usedPercent: 100 - weekly.percentRemaining,
            windowMinutes: 10080,
            resetsAt: null,
            refillsAt: weeklyRefillAt,
            rechargesAt: estimateSyntheticQuotaRechargeAt({
              usedPercent: 100 - weekly.percentRemaining,
              nextRefillAt: weeklyRefillAt,
              refillPercent: getSyntheticCreditRefillPercent(
                weekly.maxCredits,
                weekly.nextRegenCredits
              ),
              intervalMs: CREDIT_REFILL_INTERVAL_MS
            }),
            resetDescription: null
          }
        : null
    }
  } catch {
    // Network errors can contain request headers; never return their text.
    return { ...base, status: 'error', error: 'Synthetic quota request failed — try refreshing' }
  }
}
