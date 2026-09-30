/**
 * Which owners an authorized-roots rebuild has to re-list.
 *
 * Split out of registered-worktree-roots-cache so the policy is testable on its own
 * and the cache module stays within its line budget.
 */
/** The owner fields the policy reads; `undefined` means no owner record yet. */
export type RelistCandidate =
  | { dirty: boolean; listed: unknown; recovered: { size: number } }
  | undefined

/**
 * `onlyDirty` is the ensure path, where a single-repo invalidation must not relist
 * every repo. An explicit rebuild keeps re-listing everything, because callers use
 * it to force a refresh.
 *
 * A clean owner still holding recovered roots is always re-listed: those roots are
 * retired by comparing against a fresh listing, so skipping it would strand them
 * as authorized.
 */
export function shouldRelistOwner(owner: RelistCandidate, onlyDirty: boolean): boolean {
  if (!onlyDirty || owner === undefined) {
    return true
  }
  return owner.dirty || owner.listed == null || owner.recovered.size > 0
}
