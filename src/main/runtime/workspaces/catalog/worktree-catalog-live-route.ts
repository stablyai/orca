import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  setWorktreeCatalogRouteResolver,
  type WorktreeCatalogRoute
} from '../../../workspaces/catalog/repo-worktree-catalog-route'
import { getWorktreeRouteInputsRevision } from '../../../workspaces/catalog/local-worktree-scan-generation'
import { getWslDiscoveryRevision } from '../../../wsl/discovery/wsl-discovery-change'
import { resolveLocalProjectRuntimesForRepos } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { resolveWorktreeScanRuntime } from './runtime-worktree-scan-cache'

type RouteSnapshot = {
  inputsRevision: number
  wslRevision: number
  routes: Map<string, WorktreeCatalogRoute>
}

/** Every eligible repo's live route from one registry read and one project pass. */
function buildRoutes(store: RuntimeStore): Map<string, WorktreeCatalogRoute> {
  const repos = store.getRepos()
  const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(store as never, repos)
  const routes = new Map<string, WorktreeCatalogRoute>()
  for (const repo of repos) {
    if (isFolderRepo(repo)) {
      continue
    }
    const { projectRuntime, runtimeKey, sshConnectionId } = resolveWorktreeScanRuntime(
      store as never,
      repo,
      projectRuntimeByRepoId
    )
    // SSH rows answer from stored metadata and repair states cannot run local Git.
    if (sshConnectionId || projectRuntime?.status === 'repair-required') {
      continue
    }
    routes.set(`${repo.id}\0${getRepoExecutionHostId(repo)}`, { repoPath: repo.path, runtimeKey })
  }
  return routes
}

/** The catalog owner asks the live registration, not the caller, which route runs a repo's Git. */
export function registerWorktreeCatalogRoutes(store: RuntimeStore | null | undefined): void {
  if (!store) {
    return
  }
  // Rebuilt only after a route input changes; writers advance these revisions synchronously.
  let snapshot: RouteSnapshot | null = null
  setWorktreeCatalogRouteResolver((repoId, hostId) => {
    const inputsRevision = getWorktreeRouteInputsRevision()
    const wslRevision = getWslDiscoveryRevision()
    if (
      !snapshot ||
      snapshot.inputsRevision !== inputsRevision ||
      snapshot.wslRevision !== wslRevision
    ) {
      snapshot = { inputsRevision, wslRevision, routes: buildRoutes(store) }
    }
    return snapshot.routes.get(`${repoId}\0${hostId}`) ?? null
  })
}
