import {
  aliasFromCandidate,
  bypassesFreshnessDelay,
  sameAliasRequestIdentity
} from './pr-refresh-candidate-policy'
import type { GitHubPRRefreshAlias } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRRefreshQueueEntry } from './pr-refresh-queue'

/** How strong a queued request's claim to a read is: an action (manual, active, post-push), then a
 *  foreground return, other discovery, and automatic work last. */
function requestStrength(entry: PRRefreshQueueEntry): number {
  if (bypassesFreshnessDelay(entry.reason)) {
    return 3
  }
  if (entry.foreground || entry.bypassBackgroundBudget) {
    return 2
  }
  return entry.followUp || entry.errorRetry ? 0 : 1
}

/** The same shown row: one worktree, or one cache entry for a row with none. */
function sameRow(left: GitHubPRRefreshAlias, right: GitHubPRRefreshAlias): boolean {
  return left.worktreeId ? left.worktreeId === right.worktreeId : left.cacheKey === right.cacheKey
}

/**
 * Which entry a key keeps when work captured before a quota wait comes back to find `current`
 * queued. `current` is newer: its aliases win for every row they cover, and a row it queued at
 * another HEAD, link or scope supersedes the captured request, which then adds only its other
 * rows. Otherwise the stronger claim leads (the captured one only when strictly stronger) and
 * carries every row of both, so neither a routine report of another row nor a follow-up drops an
 * action.
 */
export function mergeCapturedRequest(
  current: PRRefreshQueueEntry,
  captured: PRRefreshQueueEntry
): PRRefreshQueueEntry {
  const capturedRow = aliasFromCandidate(captured.candidate)
  const newer = [aliasFromCandidate(current.candidate), ...current.aliases.values()]
  const superseded = newer.some(
    (alias) => sameRow(alias, capturedRow) && !sameAliasRequestIdentity(alias, capturedRow)
  )
  const worktrees = new Set(newer.filter((row) => row.worktreeId).map((row) => row.worktreeId))
  const caches = new Set(newer.filter((row) => !row.worktreeId).map((row) => row.cacheKey))
  const aliases = new Map(current.aliases)
  for (const alias of captured.aliases.values()) {
    if (!worktrees.has(alias.worktreeId) && !caches.has(alias.cacheKey)) {
      aliases.set(alias.cacheKey, alias)
    }
  }
  const kept =
    !superseded && requestStrength(captured) > requestStrength(current) ? captured : current
  kept.aliases = aliases
  return kept
}
