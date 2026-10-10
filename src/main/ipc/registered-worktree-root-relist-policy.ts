/**
 * Which owners an authorized-roots rebuild has to re-list.
 *
 * Split out of registered-worktree-roots-cache so the policy is testable on its own
 * and the cache module stays within its line budget.
 */
import type { Repo } from '../../shared/repo-types'
import { resolveLocalProjectRuntimesForRepos } from '../local-project-runtime-resolution'
import type { Store } from '../persistence'
import { getWorktreeMirrorDistroForRuntime } from '../project-runtime-git-options'
import type { RegisteredOwner } from './registered-worktree-root-owner'

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

/**
 * Owners whose roots came from a Git other than the one their project runtime now selects.
 *
 * A runtime awaiting repair is skipped: it names no Git, and re-listing through host Git would
 * revoke worktrees only the last real listing can name. Its owners keep that listing.
 */
export function findOwnersListedThroughAnotherGit(
  store: Store,
  repos: ReadonlyMap<string, Repo>,
  owners: ReadonlyMap<string, RegisteredOwner>
): RegisteredOwner[] {
  const runtimes = resolveLocalProjectRuntimesForRepos(store, [...repos.values()])
  return [...repos].flatMap(([key, repo]) => {
    const owner = owners.get(key)
    const runtime = runtimes.get(repo.id)
    return owner?.listed &&
      runtime?.status !== 'repair-required' &&
      owner.listedWslDistro !== getWorktreeMirrorDistroForRuntime(runtime)
      ? [owner]
      : []
  })
}
