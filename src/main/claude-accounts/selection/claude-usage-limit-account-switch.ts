import type { ClaudeAccountSwitchSettings } from '../../../shared/agent-accounts/claude/claude-account-switch-settings'
import type { ClaudeRateLimitAccountsState } from '../../../shared/agent-accounts/managed-account-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'
import { rateLimitSpentUntil } from '../../../shared/agent-usage/rate-limits/rate-limit-spent-windows'
import { DEFAULT_POLL_MS } from '../../rate-limits/service/service-types'
import { normalizeClaudeRuntimeSelection } from './runtime-selection'

/** How long to pass over an account that refused selection or is spent with no known reset. */
const UNKNOWN_SKIP_MS = DEFAULT_POLL_MS

export type ClaudeUsageLimitCandidate = {
  id: string
  /** Null when no reading has said, or the week it named is over. */
  weeklyResetsAt: number | null
  /** While in the future, the account cannot start work. */
  skipUntil: number | null
}

/** Until when the account cannot take a turn; null while it can. */
export function claudeUsageLimitEndsAt(
  limits: ProviderRateLimits | null | undefined,
  now: number
): number | null {
  if (limits?.status !== 'ok') {
    return null
  }
  const spentUntil = rateLimitSpentUntil(limits)
  if (spentUntil === undefined) {
    return null
  }
  // A kept reading can outlive its window; a reset already past means the account has room.
  return spentUntil === null ? now + UNKNOWN_SKIP_MS : spentUntil > now ? spentUntil : null
}

/** Soonest weekly reset first, so usage that expires first is spent first; unknown resets last. */
export function nextClaudeAccountAfterUsageLimit(
  candidates: readonly ClaudeUsageLimitCandidate[],
  now: number
): string | null {
  const resetOrder = (candidate: ClaudeUsageLimitCandidate): number =>
    candidate.weeklyResetsAt !== null && candidate.weeklyResetsAt > now
      ? candidate.weeklyResetsAt
      : Number.POSITIVE_INFINITY
  const usable = candidates.filter(
    (candidate) => candidate.skipUntil === null || candidate.skipUntil <= now
  )
  usable.sort((a, b) => resetOrder(a) - resetOrder(b))
  return usable[0]?.id ?? null
}

export type ClaudeUsageLimitAccountSwitchDeps = {
  rateLimits: Pick<
    RateLimitService,
    'onStateChange' | 'usageReadingAccount' | 'fetchInactiveClaudeAccountsOnOpen'
  >
  settings: () => ClaudeAccountSwitchSettings &
    Pick<GlobalSettings, 'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'>
  /** Reads each account folder, so it is asked only when a switch is due. */
  listAccounts: () => ClaudeRateLimitAccountsState
  select: (accountId: string) => Promise<unknown>
  now?: () => number
}

/** Selects the next saved Claude account once the selected one reaches a usage limit. */
export function startClaudeUsageLimitAccountSwitch(
  deps: ClaudeUsageLimitAccountSwitchDeps
): () => void {
  const now = deps.now ?? Date.now
  const known = new Map<string, Omit<ClaudeUsageLimitCandidate, 'id'>>()
  /** Kept apart from `known`, which the next reading of the account would overwrite. */
  const refusedUntil = new Map<string, number>()
  let switching = false
  /** Set when every saved account was spent, so each later reading does not ask again. */
  let noCandidateUntil = 0
  const isEnabled = (): boolean => deps.settings().claudeAccountSwitchAtUsageLimit === true
  const selectedAccountId = (): string | null =>
    normalizeClaudeRuntimeSelection(deps.settings()).host

  const remember = (accountId: string, limits: ProviderRateLimits | null): void => {
    if (limits?.status !== 'ok') {
      return
    }
    known.set(accountId, {
      weeklyResetsAt: limits.weekly?.resetsAt ?? known.get(accountId)?.weeklyResetsAt ?? null,
      skipUntil: claudeUsageLimitEndsAt(limits, now())
    })
  }

  /** The selected host account, only while the applied reading was taken under it. */
  const selectedAccountWithReading = (state: RateLimitState): string | null => {
    // Why host only: readings of other runtimes carry no account attribution.
    if (state.claudeTarget.runtime !== 'host' || state.claude?.status !== 'ok') {
      return null
    }
    const selected = selectedAccountId()
    const provenance = deps.rateLimits.usageReadingAccount('claude')?.provenance
    return selected && provenance === `profile:${selected}` ? selected : null
  }

  const candidatesFor = (selected: string): ClaudeUsageLimitCandidate[] =>
    deps
      .listAccounts()
      .accounts.filter(
        (account) =>
          account.id !== selected &&
          (account.managedAuthRuntime ?? 'host') === 'host' &&
          !account.needsSignIn &&
          // Its usage is System default's, which no reading attributes to it.
          !account.runsOnSystemDefault
      )
      .map((account) => ({
        id: account.id,
        weeklyResetsAt: known.get(account.id)?.weeklyResetsAt ?? null,
        skipUntil: Math.max(
          known.get(account.id)?.skipUntil ?? 0,
          refusedUntil.get(account.id) ?? 0
        )
      }))

  const switchAway = async (selected: string): Promise<void> => {
    // Saved accounts are read only on demand; ask when one has no reading to order it by.
    if (candidatesFor(selected).some((candidate) => !known.has(candidate.id))) {
      await deps.rateLimits.fetchInactiveClaudeAccountsOnOpen().catch(() => {})
      if (!isEnabled() || selectedAccountId() !== selected) {
        return
      }
    }
    const next = nextClaudeAccountAfterUsageLimit(candidatesFor(selected), now())
    if (!next) {
      noCandidateUntil = now() + UNKNOWN_SKIP_MS
      return
    }
    try {
      await deps.select(next)
    } catch (error) {
      console.warn('[claude-accounts] Could not switch accounts at the usage limit:', error)
      refusedUntil.set(next, now() + UNKNOWN_SKIP_MS)
    }
  }

  // Why no timer: a switch is decided only when a reading of the selected account arrives.
  const unsubscribe = deps.rateLimits.onStateChange((state) => {
    for (const inactive of state.inactiveClaudeAccounts) {
      remember(inactive.accountId, inactive.rateLimits)
    }
    const selected = selectedAccountWithReading(state)
    if (!selected) {
      return
    }
    remember(selected, state.claude)
    const skipUntil = known.get(selected)?.skipUntil ?? null
    if (switching || !isEnabled() || skipUntil === null || skipUntil <= now()) {
      return
    }
    if (now() < noCandidateUntil) {
      return
    }
    switching = true
    void switchAway(selected).finally(() => {
      switching = false
    })
  })

  return unsubscribe
}
