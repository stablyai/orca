import type { GitHubPRRefreshAlias, GitHubPRRefreshCandidate } from '../../shared/types'
import {
  PR_REFRESH_ALIAS_LIMIT,
  PR_REFRESH_VISIBLE_CANDIDATE_LIMIT
} from '../../shared/pr-refresh-memory-limits'

export {
  PR_REFRESH_ACTIVE_SCOPE_LIMIT,
  PR_REFRESH_ALIAS_LIMIT,
  PR_REFRESH_QUEUE_ENTRY_LIMIT,
  PR_REFRESH_RETRY_STATE_LIMIT,
  PR_REFRESH_VISIBLE_CANDIDATE_LIMIT
} from '../../shared/pr-refresh-memory-limits'

export function retainPRRefreshAlias(
  aliases: Map<string, GitHubPRRefreshAlias>,
  alias: GitHubPRRefreshAlias,
  protectedCacheKey: string
): GitHubPRRefreshAlias | null {
  if (aliases.has(alias.cacheKey)) {
    aliases.delete(alias.cacheKey)
    aliases.set(alias.cacheKey, alias)
    return null
  }
  if (aliases.size < PR_REFRESH_ALIAS_LIMIT) {
    aliases.set(alias.cacheKey, alias)
    return null
  }

  let evictionKey: string | undefined
  for (const cacheKey of aliases.keys()) {
    if (cacheKey !== protectedCacheKey) {
      evictionKey = cacheKey
      break
    }
  }
  if (evictionKey === undefined) {
    return alias
  }
  const evicted = aliases.get(evictionKey) ?? null
  aliases.delete(evictionKey)
  aliases.set(alias.cacheKey, alias)
  return evicted
}

export function retainPRRefreshState<K, V>(
  entries: Map<K, V>,
  key: K,
  value: V,
  limit: number
): K | null {
  if (entries.has(key)) {
    entries.delete(key)
    entries.set(key, value)
    return null
  }
  let evictedKey: K | null = null
  if (entries.size >= limit) {
    const oldest = entries.keys().next()
    if (!oldest.done) {
      evictedKey = oldest.value
      entries.delete(oldest.value)
    }
  }
  entries.set(key, value)
  return evictedKey
}

export function boundedVisiblePRRefreshCandidates(
  candidates: GitHubPRRefreshCandidate[]
): GitHubPRRefreshCandidate[] {
  return candidates.length <= PR_REFRESH_VISIBLE_CANDIDATE_LIMIT
    ? candidates
    : candidates.slice(0, PR_REFRESH_VISIBLE_CANDIDATE_LIMIT)
}
