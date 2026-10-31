import type { Worktree } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import { getRepoHostIdentityForParts } from '../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../shared/worktree/visibility-sources'
import { createRepoRowExecutionHostLookup } from '../../shared/worktree-execution-host-resolution'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'

export function buildRuntimeWorktreeVisibilityMatchers(
  repos: readonly Repo[],
  resolved: readonly Worktree[],
  visibilityDefaults: Parameters<typeof resolveCustomWorktreeVisibilitySources>[1]
) {
  const owners = createRepoRowExecutionHostLookup(repos)
  const pathsByRepo = new Map<string, string[]>()
  for (const worktree of resolved) {
    const owner = resolveWorktreeHostRouting(repos, worktree, owners)
    if (owner.kind !== 'resolved') {
      continue
    }
    const key = getRepoHostIdentityForParts(worktree.repoId, owner.hostId)
    const paths = pathsByRepo.get(key) ?? []
    paths.push(worktree.path)
    pathsByRepo.set(key, paths)
  }
  return new Map(
    repos.map((repo) => [
      getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo)),
      createWorktreeVisibilitySourceMatcher(
        [
          repo.path,
          ...(pathsByRepo.get(getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))) ??
            [])
        ],
        resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
        resolveConfiguredWorktreeBasePaths(repo)
      )
    ])
  )
}
