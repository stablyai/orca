import type {
  InactiveAccountUsage,
  ProviderRateLimits
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'

export { DEFAULT_AUTO_SWITCH_THRESHOLD } from '../../../shared/agent-accounts/claude/claude-account-switch-settings'

type Rotation = NonNullable<GlobalSettings['claudeAccountRotation']>

function peakUsed(limits: ProviderRateLimits | null): number | null {
  if (!limits) {
    return null
  }
  const values = [limits.session?.usedPercent, limits.weekly?.usedPercent].filter(
    (value): value is number => typeof value === 'number'
  )
  return values.length > 0 ? Math.max(...values) : null
}

/** Next account to use, or null when the active one should stay. */
export function pickAutoSwitchTarget(input: {
  activeId: string
  active: ProviderRateLimits | null
  inactive: InactiveAccountUsage[]
  accountIds: string[]
  rotation: Rotation
  defaultThreshold: number
}): string | null {
  const { rotation, defaultThreshold } = input
  const limit = (id: string): number => rotation[id]?.threshold ?? defaultThreshold
  const activeUsed = peakUsed(input.active)
  if (activeUsed === null || activeUsed < limit(input.activeId)) {
    return null
  }
  const usage = new Map(
    input.inactive.map((entry) => [entry.accountId, peakUsed(entry.rateLimits)])
  )
  const candidates = input.accountIds
    .filter((id) => id !== input.activeId && !rotation[id]?.disabled)
    // ponytail: an account with no reading yet counts as empty; a stale cache can bounce once.
    .map((id) => ({ id, used: usage.get(id) ?? 0 }))
    .filter((entry) => entry.used < limit(entry.id))
    .sort(
      (a, b) => (rotation[b.id]?.priority ?? 0) - (rotation[a.id]?.priority ?? 0) || a.used - b.used
    )
  return candidates[0]?.id ?? null
}
