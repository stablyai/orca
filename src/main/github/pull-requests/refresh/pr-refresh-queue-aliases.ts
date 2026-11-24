import type { GitHubPRRefreshAlias } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'

/** Retire old-branch aliases when a linked-PR key survives worktree branch changes. */
export function setLiveAlias(
  aliases: Map<string, GitHubPRRefreshAlias>,
  alias: GitHubPRRefreshAlias
): void {
  if (alias.worktreeId) {
    for (const [cacheKey, existing] of aliases) {
      if (cacheKey !== alias.cacheKey && existing.worktreeId === alias.worktreeId) {
        aliases.delete(cacheKey)
      }
    }
  }
  aliases.set(alias.cacheKey, alias)
}

/** Queued aliases are newer than request-time follow-ups; preserve them with their matching candidate. */
export function mergeFollowUpAlias(
  aliases: Map<string, GitHubPRRefreshAlias>,
  alias: GitHubPRRefreshAlias
): GitHubPRRefreshAlias | undefined {
  if (alias.worktreeId) {
    for (const existing of aliases.values()) {
      if (existing.worktreeId === alias.worktreeId) {
        return existing
      }
    }
  }
  setLiveAlias(aliases, alias)
  return undefined
}

/** Manual refresh writes copied maps back; keep the latest branch per worktree on re-entry too. */
export function dropSupersededWorktreeAliases(aliases: Map<string, GitHubPRRefreshAlias>): void {
  const liveCacheKeyByWorktree = new Map<string, string>()
  for (const [cacheKey, alias] of aliases) {
    if (!alias.worktreeId) {
      continue
    }
    const superseded = liveCacheKeyByWorktree.get(alias.worktreeId)
    if (superseded !== undefined) {
      aliases.delete(superseded)
    }
    liveCacheKeyByWorktree.set(alias.worktreeId, cacheKey)
  }
}
