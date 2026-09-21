import {
  normalizeSuggestedName,
  selectSuggestedCreatureName,
  suggestionPathBasename
} from '../../../src/shared/worktree-name-suggestion'
import {
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from '../../../src/shared/worktree/retired-name-registry'

// Why: this used to hand-duplicate the desktop algorithm and the two drifted apart by
// construction. Both now call the shared core so a name suggested on a phone and one suggested on
// the desktop obey the same rules. The dedupe is on the on-disk directory basename, not the
// user-facing displayName, because that is what actually collides.

/** `retired` holds names already spent in the selected repo, including workspaces that have since
 *  been deleted — their directories may still hold agent conversation state keyed by cwd, so
 *  reissuing the name would hand it to the next occupant. Its `exhaustedTiers` watermark covers
 *  the tiers the host has compacted away, whose names it therefore no longer sends individually.
 *
 *  Hosts older than these fields send nothing, in which case this degrades to deduping against
 *  live paths only, exactly as it did before. */
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
