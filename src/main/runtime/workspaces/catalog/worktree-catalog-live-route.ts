import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import {
  setWorktreeCatalogRouteResolver,
  type WorktreeCatalogRoute
} from '../../../workspaces/catalog/repo-worktree-catalog-route'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { resolveWorktreeScanRuntime } from './runtime-worktree-scan-cache'

/** The catalog owner asks the live registration, not the caller, which route runs a repo's Git. */
export function registerWorktreeCatalogRoutes(store: RuntimeStore | null | undefined): void {
  if (!store) {
    return
  }
  // One registry snapshot per synchronous pass: owners check liveness per entry, and hydrating
  // every repo for each check would make fleet reads quadratic.
  let routes: Map<string, WorktreeCatalogRoute | null> | null = null
  let repos: Map<string, Repo> | null = null
  setWorktreeCatalogRouteResolver((repoId, hostId) => {
    if (!routes || !repos) {
      routes = new Map()
      repos = new Map(
        store.getRepos().map((repo) => [`${repo.id}\0${getRepoExecutionHostId(repo)}`, repo])
      )
      queueMicrotask(() => {
        routes = null
        repos = null
      })
    }
    const key = `${repoId}\0${hostId}`
    if (routes.has(key)) {
      return routes.get(key) ?? null
    }
    const repo = repos.get(key)
    let route: WorktreeCatalogRoute | null = null
    if (repo && !isFolderRepo(repo)) {
      const { runtimeKey, sshConnectionId } = resolveWorktreeScanRuntime(store as never, repo)
      route = sshConnectionId ? null : { repoPath: repo.path, runtimeKey }
    }
    routes.set(key, route)
    return route
  })
}
