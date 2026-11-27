import * as z from 'zod'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  parseUsageHistory,
  type UsageWindowHistory
} from '../../../shared/agent-usage/rate-limits/usage-window-history'

/** One window's series for one provider account; `account` is '' when the reading names none. */
export type AccountUsageSeries = {
  provider: string
  account: string
  windowId: string
  history: UsageWindowHistory
}

export type PersistedUsageHistory = {
  /** Each provider's account at its latest reading: whose series the graph shows. */
  activeAccounts: Record<string, string>
  series: AccountUsageSeries[]
}

// Far above a full store (128 series of 168 points is ~1 MB); anything larger is not ours to parse.
export const USAGE_HISTORY_FILE_MAX_BYTES = 4 * 1024 * 1024

const FileSchema = z.object({
  version: z.literal(2),
  activeAccounts: z.record(z.string(), z.string()),
  series: z.array(
    z.looseObject({ provider: z.string(), account: z.string(), windowId: z.string() })
  )
})

/** Reads the saved store; version 1 (flat `provider:window` keys) carries over as unattributed. */
export function parseUsageHistoryFile(raw: unknown): PersistedUsageHistory {
  const file = FileSchema.safeParse(raw)
  if (!file.success) {
    const legacy = parseUsageHistory(raw)
    return {
      activeAccounts: {},
      series: Object.entries(legacy).flatMap(([key, history]) => {
        const split = key.indexOf(':')
        return split > 0
          ? [
              {
                provider: key.slice(0, split),
                account: '',
                windowId: key.slice(split + 1),
                history
              }
            ]
          : []
      })
    }
  }
  return {
    activeAccounts: file.data.activeAccounts,
    series: file.data.series.flatMap(({ provider, account, windowId, ...rest }) => {
      const history = parseUsageHistory({ series: rest }).series
      return history ? [{ provider, account, windowId, history }] : []
    })
  }
}

export function serializeUsageHistoryFile(store: PersistedUsageHistory): string {
  return JSON.stringify({
    version: 2,
    activeAccounts: store.activeAccounts,
    series: store.series.map(({ provider, account, windowId, history }) => ({
      provider,
      account,
      windowId,
      ...history
    }))
  })
}

/** Which login a reading belongs to, so one account's history never continues another's. */
export function usageReadingAccountKey(limits: ProviderRateLimits): string {
  const metadata = limits.usageMetadata
  const saved = metadata?.readingAccount?.accountId ?? metadata?.authFailureAccount?.accountId
  if (saved) {
    return saved
  }
  // Grok names its login as "email (tier)"; a plan change is the same account.
  const provenance = metadata?.authProvenance?.replace(/\s*\(.*\)$/, '')
  return provenance?.includes('@') ? provenance : ''
}
