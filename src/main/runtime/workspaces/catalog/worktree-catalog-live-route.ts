import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { setWorktreeCatalogRouteResolver } from '../../../workspaces/catalog/repo-worktree-catalog-route'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { resolveWorktreeScanRuntime } from './runtime-worktree-scan-cache'

/** The catalog owner asks the live registration, not the caller, which route runs a repo's Git. */
export function registerWorktreeCatalogRoutes(store: RuntimeStore | null | undefined): void {
  if (!store) {
    return
  }
  setWorktreeCatalogRouteResolver((repoId, hostId) => {
    const repo = store
      .getRepos()
      .find((candidate) => candidate.id === repoId && getRepoExecutionHostId(candidate) === hostId)
    if (!repo || isFolderRepo(repo)) {
      return null
    }
    const { runtimeKey, sshConnectionId } = resolveWorktreeScanRuntime(store as never, repo)
    return sshConnectionId ? null : { repoPath: repo.path, runtimeKey }
  })
}
