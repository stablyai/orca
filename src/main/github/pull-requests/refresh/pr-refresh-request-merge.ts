import {
  aliasFromCandidate,
  bypassesFreshnessDelay,
  sameAliasRequestIdentity
} from './pr-refresh-candidate-policy'
import type { PRRefreshQueueEntry } from './pr-refresh-queue'
import { mergeFollowUpAlias } from './pr-refresh-queue-aliases'

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

/**
 * Which entry a key keeps when work captured before a quota wait comes back to find `current`
 * queued: for the same request the stronger claim (the captured one only when strictly stronger),
 * carrying both entries' aliases, so a routine follow-up never demotes an action; none when
 * `current` is another request, which is newer and stays as it is.
 */
export function mergeCapturedRequest(
  current: PRRefreshQueueEntry,
  captured: PRRefreshQueueEntry
): PRRefreshQueueEntry | null {
  if (
    !sameAliasRequestIdentity(
      aliasFromCandidate(current.candidate),
      aliasFromCandidate(captured.candidate)
    )
  ) {
    return null
  }
  const [kept, merged] =
    requestStrength(captured) > requestStrength(current) ? [captured, current] : [current, captured]
  for (const alias of merged.aliases.values()) {
    mergeFollowUpAlias(kept.aliases, alias)
  }
  return kept
}
