import type { Repo } from '../../shared/repo-types'
import { resolveLocalProjectRuntimesForRepos } from '../local-project-runtime-resolution'
import type { RegisteredWorktreeRootStore as RootStore } from './registered-worktree-root-store'
import { getWorktreeMirrorDistroForRuntime } from '../project-runtime-git-options'
import type { RegisteredOwner } from './registered-worktree-root-owner'

/** The owner fields the policy reads; `undefined` means no owner record yet. */
export type RelistCandidate =
  | { dirty: boolean; listed: unknown; recovered: { size: number } }
  | undefined

/** Ensure relists dirty/unlisted owners; explicit rebuild relists all. Recovered roots require fresh listing before retirement. */
export function shouldRelistOwner(owner: RelistCandidate, onlyDirty: boolean): boolean {
  if (!onlyDirty || owner === undefined) {
    return true
  }
  return owner.dirty || owner.listed == null || owner.recovered.size > 0
}

/** Detect runtime Git changes; keep repair-pending owners on their last real listing rather than revoking WSL-only roots. */
export function findOwnersListedThroughAnotherGit(
  store: RootStore,
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
