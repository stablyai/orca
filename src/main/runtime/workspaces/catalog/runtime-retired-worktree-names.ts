import {
  getRetiredNameRegistryForRepo,
  hasRetiredNameRegistryStore
} from '../../../workspaces/removal/retirement/worktree-name-retirement'
import type { RuntimeManagedWorktreeQueryDependencies } from './runtime-managed-worktree-query-dependencies'

export async function listRuntimeRetiredWorktreeNames(
  deps: RuntimeManagedWorktreeQueryDependencies,
  repoSelector: string
): Promise<{
  retiredNamesByRepo: Record<string, readonly string[]>
  retiredNameTiersByRepo: Record<string, number>
}> {
  const store = deps.getStore()
  if (!store || !hasRetiredNameRegistryStore(store)) {
    return { retiredNamesByRepo: {}, retiredNameTiersByRepo: {} }
  }
  const repo = await deps.resolveRepo(repoSelector)
  const settings = store.getSettings()
  const registry = await getRetiredNameRegistryForRepo(store, repo, store.getRepos(), settings)
  return {
    retiredNamesByRepo: { [repo.id]: registry.names },
    retiredNameTiersByRepo: { [repo.id]: registry.exhaustedTiers }
  }
}
