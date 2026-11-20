import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitState
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { ClaudeRateLimitAccountsState } from '../../../shared/agent-accounts/managed-account-types'
import { normalizeClaudeRuntimeSelection } from './runtime-selection'
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

const COOLDOWN_MS = 60_000
const FAILED_RETRY_MS = 10 * 60_000

type AutoSwitchSettings = Pick<
  GlobalSettings,
  | 'claudeAutoSwitch'
  | 'claudeAccountRotation'
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
>

/** A state listener that moves the host's active Claude account off one that is nearly out of quota. */
export function createClaudeAutoSwitch(deps: {
  getSettings: () => AutoSwitchSettings
  listAccounts: () => ClaudeRateLimitAccountsState
  select: (accountId: string) => Promise<unknown>
  now?: () => number
}): (state: RateLimitState) => void {
  const now = deps.now ?? Date.now
  const failedAt = new Map<string, number>()
  let lastAttemptAt = -Infinity
  let busy = false
  return (state) => {
    const settings = deps.getSettings()
    const auto = settings.claudeAutoSwitch
    const activeId = normalizeClaudeRuntimeSelection(settings).host
    if (!auto?.enabled || !activeId || busy || now() - lastAttemptAt < COOLDOWN_MS) {
      return
    }
    // The meter can be reading a WSL account or the one we just left; act only on the host account's own reading.
    // An account covered by System default has no attributed reading, so it is not auto-switched.
    const reading = state.claude?.usageMetadata?.readingAccount
    if (
      state.claudeTarget.runtime !== 'host' ||
      reading?.accountId !== activeId ||
      reading.runtime !== 'host'
    ) {
      return
    }
    const pick = (accountIds: string[]): string | null =>
      pickAutoSwitchTarget({
        activeId,
        active: state.claude,
        inactive: state.inactiveClaudeAccounts,
        accountIds,
        rotation: settings.claudeAccountRotation ?? {},
        defaultThreshold: auto.threshold
      })
    // Cheap check first: listing accounts reads their folders.
    if (!pick(settings.claudeManagedAccounts.map((account) => account.id))) {
      return
    }
    const usable = deps
      .listAccounts()
      .accounts.filter(
        (account) =>
          !account.needsSignIn &&
          (account.managedAuthRuntime ?? 'host') === 'host' &&
          now() - (failedAt.get(account.id) ?? -Infinity) >= FAILED_RETRY_MS
      )
      .map((account) => account.id)
    const target = pick(usable)
    if (!target) {
      return
    }
    busy = true
    lastAttemptAt = now()
    deps
      .select(target)
      .catch((error: unknown) => {
        // Skip it for a while so a broken account cannot trap the rotation.
        failedAt.set(target, now())
        console.warn('[claude-accounts] Auto-switch failed:', error)
      })
      .finally(() => {
        busy = false
      })
  }
}
