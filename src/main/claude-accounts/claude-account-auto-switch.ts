import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import type {
  ProviderRateLimits,
  RateLimitState,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import {
  DEFAULT_CLAUDE_AUTO_SWITCH_MIN_SESSION_HEADROOM,
  DEFAULT_CLAUDE_AUTO_SWITCH_MIN_WEEKLY_HEADROOM
} from '../../shared/claude-account-switch-settings'
import type { RateLimitService } from '../rate-limits/service'
import { STALE_THRESHOLD_MS } from '../rate-limits/service/service-types'
import type { ClaudeAccountService } from './service'
import {
  getClaudeSelectionTargetForAccount,
  getClaudeWslSelectionKey,
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'

// Why: bounds both flapping and the inactive-usage fetches each attempt makes.
export const CLAUDE_AUTO_SWITCH_COOLDOWN_MS = 10 * 60 * 1000

export type ClaudeAutoSwitchSettings = Pick<
  GlobalSettings,
  | 'claudeAccountAutoSwitch'
  | 'claudeAccountAutoSwitchMinSessionHeadroom'
  | 'claudeAccountAutoSwitchMinWeeklyHeadroom'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
>

type Headroom = { session: number | null; weekly: number | null }

/** Null when the reading is missing, failed or old; a window past its reset counts as unknown. */
function readHeadroom(usage: ProviderRateLimits | null | undefined, now: number): Headroom | null {
  if (!usage || usage.status !== 'ok' || now - usage.updatedAt > STALE_THRESHOLD_MS) {
    return null
  }
  const left = (window: RateLimitWindow | null): number | null =>
    window && (window.resetsAt === null || window.resetsAt > now) ? 100 - window.usedPercent : null
  return { session: left(usage.session), weekly: left(usage.weekly) }
}

function minimums(settings: ClaudeAutoSwitchSettings): { session: number; weekly: number } {
  return {
    session:
      settings.claudeAccountAutoSwitchMinSessionHeadroom ??
      DEFAULT_CLAUDE_AUTO_SWITCH_MIN_SESSION_HEADROOM,
    weekly:
      settings.claudeAccountAutoSwitchMinWeeklyHeadroom ??
      DEFAULT_CLAUDE_AUTO_SWITCH_MIN_WEEKLY_HEADROOM
  }
}

function isSameTarget(a: ClaudeAccountSelectionTarget, b: ClaudeAccountSelectionTarget): boolean {
  const left = normalizeClaudeAccountSelectionTarget(a)
  const right = normalizeClaudeAccountSelectionTarget(b)
  return (
    left.runtime === right.runtime &&
    (left.runtime === 'host' ||
      getClaudeWslSelectionKey(left.wslDistro) === getClaudeWslSelectionKey(right.wslDistro))
  )
}

/** The selected account on the usage target when either known window is below its minimum. */
function lowSelectedAccount(
  state: RateLimitState,
  settings: ClaudeAutoSwitchSettings,
  now: number
): string | null {
  if (!settings.claudeAccountAutoSwitch) {
    return null
  }
  const accountId = getSelectedClaudeAccountIdForTarget(settings, state.claudeTarget)
  const left = readHeadroom(state.claude, now)
  if (!accountId || !left) {
    return null
  }
  const min = minimums(settings)
  return (left.session !== null && left.session < min.session) ||
    (left.weekly !== null && left.weekly < min.weekly)
    ? accountId
    : null
}

/** Another signed-in account on the same runtime with both windows known and at or above the minimums; the one whose scarcer window has the most left wins. */
function pickNextAccount(
  state: RateLimitState,
  accounts: ClaudeRateLimitAccountsState,
  fromAccountId: string,
  settings: ClaudeAutoSwitchSettings,
  now: number
): string | null {
  const min = minimums(settings)
  let best: { accountId: string; left: number } | null = null
  for (const account of accounts.accounts) {
    if (
      account.id === fromAccountId ||
      account.needsSignIn ||
      !isSameTarget(getClaudeSelectionTargetForAccount(account), state.claudeTarget)
    ) {
      continue
    }
    const usage = state.inactiveClaudeAccounts.find((entry) => entry.accountId === account.id)
    const left = readHeadroom(usage?.rateLimits, now)
    if (
      left?.session == null ||
      left.weekly == null ||
      left.session < min.session ||
      left.weekly < min.weekly
    ) {
      continue
    }
    const scarcer = Math.min(left.session, left.weekly)
    if (!best || scarcer > best.left) {
      best = { accountId: account.id, left: scarcer }
    }
  }
  return best?.accountId ?? null
}

/** Opt-in: selects another Claude account when the selected one's usage drops below the minimums. */
export function startClaudeAccountAutoSwitch(deps: {
  getSettings: () => ClaudeAutoSwitchSettings
  rateLimits: Pick<
    RateLimitService,
    'getState' | 'onStateChange' | 'fetchInactiveClaudeAccountsOnOpen'
  >
  claudeAccounts: Pick<ClaudeAccountService, 'listAccounts' | 'hasPendingLogin'>
  select: (accountId: string) => Promise<unknown>
  notifyNoCandidate: (accounts: ClaudeRateLimitAccountsState, accountId: string) => void
}): () => void {
  let lastAttemptAt = Number.NEGATIVE_INFINITY
  let attempting = false
  let notifiedAccountId: string | null = null

  const attempt = async (fromAccountId: string): Promise<void> => {
    attempting = true
    lastAttemptAt = Date.now()
    try {
      // Why: inactive readings are otherwise only fetched when a switcher opens.
      await deps.rateLimits.fetchInactiveClaudeAccountsOnOpen()
      const state = deps.rateLimits.getState()
      const settings = deps.getSettings()
      // Why: the selection or its reading may have changed during the fetch.
      if (lowSelectedAccount(state, settings, Date.now()) !== fromAccountId) {
        return
      }
      const accounts = deps.claudeAccounts.listAccounts()
      const toAccountId = pickNextAccount(state, accounts, fromAccountId, settings, Date.now())
      if (!toAccountId) {
        console.warn(
          `[claude-accounts] Auto-switch: no other Claude account has known usage above the minimums; keeping ${fromAccountId}.`
        )
        if (notifiedAccountId !== fromAccountId) {
          notifiedAccountId = fromAccountId
          deps.notifyNoCandidate(accounts, fromAccountId)
        }
        return
      }
      console.info(
        `[claude-accounts] Auto-switch: usage of ${fromAccountId} is below the minimum; selecting ${toAccountId}.`
      )
      notifiedAccountId = null
      await deps.select(toAccountId)
    } catch (error) {
      console.warn('[claude-accounts] Auto-switch failed:', error)
    } finally {
      attempting = false
    }
  }

  return deps.rateLimits.onStateChange((state) => {
    const fromAccountId = lowSelectedAccount(state, deps.getSettings(), Date.now())
    if (!fromAccountId) {
      return
    }
    // Why: switching cancels a pending sign-in, often the account being added for this.
    if (
      attempting ||
      Date.now() - lastAttemptAt < CLAUDE_AUTO_SWITCH_COOLDOWN_MS ||
      deps.claudeAccounts.hasPendingLogin()
    ) {
      return
    }
    void attempt(fromAccountId)
  })
}
