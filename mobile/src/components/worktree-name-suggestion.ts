import {
  normalizeSuggestedName,
  selectSuggestedCreatureName,
  suggestionPathBasename
} from '../../../src/shared/worktree-name-suggestion'
import {
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from '../../../src/shared/worktree/retired-name-registry'

// Share the desktop algorithm; collisions use the on-disk basename, not displayName.

// Retired names may retain conversation state keyed by cwd; exhaustedTiers covers compacted names the host no longer sends individually.
// Older hosts omit both fields, retaining deduplication against live paths only.
export function getSuggestedCreatureName(
  existingPaths: readonly string[],
  random: () => number = Math.random,
  retired: RetiredNameRegistry = EMPTY_RETIRED_NAME_REGISTRY
): string {
  const used = new Set<string>()
  for (const path of existingPaths) {
    used.add(normalizeSuggestedName(suggestionPathBasename(path)))
  }
  for (const retiredName of retired.names) {
    used.add(normalizeSuggestedName(retiredName))
  }
  return selectSuggestedCreatureName(used, random, retired.exhaustedTiers)
}
