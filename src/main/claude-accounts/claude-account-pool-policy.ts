import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { claudeAutoSwitchHeadroom } from './claude-account-auto-switch-policy'
import { isClaudeUsageFresh } from './claude-session-mover-policy'

/** Below this, an account is too close to a line to receive a new pooled launch. */
export const CLAUDE_POOL_MIN_HEADROOM_PTS = 10

export type ClaudePoolAccount = {
  id: string
  signedIn: boolean
  /** The account new non-pooled launches and the status bar use. */
  selected?: boolean
  /** Unix ms. The account is skipped while `now` is still before this. */
  failureHoldUntil?: number
}

export type ClaudePoolUsage = {
  accountId: string
  rateLimits: ProviderRateLimits | null
  updatedAt: number
}

export type ClaudePoolChoice = {
  accountId: string
  /** `chosen` won on headroom. `fallback` is the selected account because nothing usable ranked. */
  kind: 'chosen' | 'fallback'
}

/**
 * The account a new pooled Claude launch should use.
 * Greatest headroom wins (the same 5-hour / weekly / Fable-weekly minimum as auto-switch).
 * Ties break to the fewest assigned sessions, then to the order of `accounts`.
 * Returns null only when no account is selected and nothing ranked.
 */
export function chooseClaudePoolAccount(input: {
  accounts: readonly ClaudePoolAccount[]
  usage: readonly ClaudePoolUsage[]
  now: number
  /** Hand-pinned sessions per account. A positive count keeps that account out of the pool. */
  pinnedCounts: Readonly<Record<string, number>>
  /** Live panes per account. Tie-break: fewer wins. */
  assignedCounts: Readonly<Record<string, number>>
}): ClaudePoolChoice | null {
  const selected = input.accounts.find((account) => account.selected)
  const usageById = new Map(input.usage.map((row) => [row.accountId, row]))
  const ranked: { id: string; headroom: number; assigned: number; index: number }[] = []
  input.accounts.forEach((account, index) => {
    if (!account.signedIn) {
      return
    }
    if (account.failureHoldUntil !== undefined && account.failureHoldUntil > input.now) {
      return
    }
    // Why: a hand-typed session already owns this folder; a new Orca launch goes elsewhere.
    if ((input.pinnedCounts[account.id] ?? 0) > 0) {
      return
    }
    const row = usageById.get(account.id) ?? null
    // A stale or missing reading is unknown. It is not ranked.
    if (!isClaudeUsageFresh(row, input.now)) {
      return
    }
    const headroom = claudeAutoSwitchHeadroom(row?.rateLimits ?? null, input.now)
    if (headroom === null || headroom < CLAUDE_POOL_MIN_HEADROOM_PTS) {
      return
    }
    ranked.push({
      id: account.id,
      headroom,
      assigned: input.assignedCounts[account.id] ?? 0,
      index
    })
  })
  if (ranked.length === 0) {
    return selected ? { accountId: selected.id, kind: 'fallback' } : null
  }
  ranked.sort((a, b) => b.headroom - a.headroom || a.assigned - b.assigned || a.index - b.index)
  const best = ranked[0]
  return best ? { accountId: best.id, kind: 'chosen' } : null
}
