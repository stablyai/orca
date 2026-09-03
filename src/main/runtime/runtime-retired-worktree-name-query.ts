import { getRetiredNameRegistryForRepo } from '../worktree-name-retirement'
import type { RuntimeStore } from './runtime-store-contract'
import type { Worktree } from '../../shared/worktree/types'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'

/** Build visibility matchers only for repositories represented in the resolved result. */
export function buildRuntimeVisibilityMatchers(args: {
  store: RuntimeStore | null
  worktrees: readonly Worktree[]
  visibilityDefaults: ReturnType<RuntimeStore['getSettings']>['worktreeVisibilityDefaults']
}) {
  const pathsByRepo = new Map<string, string[]>()
  for (const worktree of args.worktrees) {
    const paths = pathsByRepo.get(worktree.repoId) ?? []
    paths.push(worktree.path)
    pathsByRepo.set(worktree.repoId, paths)
  }
  return new Map(
    (args.store?.getRepos() ?? [])
      .filter((repo) => pathsByRepo.has(repo.id))
      .map((repo) => [
        repo.id,
        createWorktreeVisibilitySourceMatcher(
          [repo.path, ...(pathsByRepo.get(repo.id) ?? [])],
          resolveCustomWorktreeVisibilitySources(repo, args.visibilityDefaults),
          resolveConfiguredWorktreeBasePaths(repo)
        )
      ])
  )
}

/** Respect clients that predate source-specific worktree visibility defaults. */
export function resolveRuntimeVisibilityDefaults(
  store: RuntimeStore | null,
  sourceDefaultsSupported: boolean,
  providedSettings?: ReturnType<RuntimeStore['getSettings']>
) {
  const defaults =
    providedSettings?.worktreeVisibilityDefaults ?? store?.getSettings().worktreeVisibilityDefaults
  return sourceDefaultsSupported || !defaults ? defaults : { external: defaults.external }
}

/** Resolve the retired-name registry without expanding the managed-worktree query coordinator. */
export async function listRuntimeRetiredWorktreeNames(
  store: RuntimeStore | null,
  resolveRepo: (selector: string) => Promise<{ id: string }>,
  repoSelector: string
): Promise<{
  retiredNamesByRepo: Record<string, readonly string[]>
  retiredNameTiersByRepo: Record<string, number>
}> {
  if (!store?.getRetiredWorktreeNameRegistry || !store.mergeRetiredWorktreeNames) {
    return { retiredNamesByRepo: {}, retiredNameTiersByRepo: {} }
  }
  const repo = await resolveRepo(repoSelector)
  const settings = store.getSettings()
  const registry = await getRetiredNameRegistryForRepo(
    store as never,
    repo as never,
    store.getRepos(),
    settings
  )
  return {
    retiredNamesByRepo: { [repo.id]: registry.names },
    retiredNameTiersByRepo: { [repo.id]: registry.exhaustedTiers }
  }
}
