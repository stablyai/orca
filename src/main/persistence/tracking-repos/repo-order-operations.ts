import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'

export type RepoOrderMutationOperations = {
  state: StoreOwnedPersistedState
  syncProjectHostSetupCompatibilityState: () => void
  scheduleSave: () => void
}

export class RepoOrderPersistenceOperations {
  constructor(private readonly operations: RepoOrderMutationOperations) {}

  private get state(): PersistedState {
    return this.operations.state
  }

  private syncProjectHostSetupCompatibilityState(): void {
    this.operations.syncProjectHostSetupCompatibilityState()
  }

  private scheduleSave(): void {
    this.operations.scheduleSave()
  }

  addRepo(repo: Repo): void {
    this.state.repos.push(repo)
    this.syncProjectHostSetupCompatibilityState()
    this.scheduleSave()
  }

  // Why: return false on a stale permutation (concurrent add/remove) so the caller resyncs instead of persisting an order that drops/duplicates ids.
  reorderRepos(orderedIds: string[]): boolean {
    const current = this.state.repos
    if (orderedIds.length !== current.length) {
      return false
    }
    const seen = new Set<string>()
    for (const id of orderedIds) {
      if (typeof id !== 'string' || seen.has(id)) {
        return false
      }
      seen.add(id)
    }
    const byId = new Map<string, Repo>()
    for (const r of current) {
      byId.set(r.id, r)
    }
    const next: Repo[] = []
    for (const id of orderedIds) {
      const repo = byId.get(id)
      if (!repo) {
        return false
      }
      next.push(repo)
    }
    this.state.repos = next
    this.syncProjectHostSetupCompatibilityState()
    this.scheduleSave()
    return true
  }

  // Why: repo ids are unique only within an execution host; drags persist one permutation per host when local and SSH repos coexist.
  reorderReposForHost(orderedIds: string[], hostId: ExecutionHostId): boolean {
    const current = this.state.repos
    const hostRepos = current.filter((repo) => getRepoExecutionHostId(repo) === hostId)
    if (orderedIds.length !== hostRepos.length) {
      return false
    }
    const byId = new Map(hostRepos.map((repo) => [repo.id, repo]))
    if (byId.size !== hostRepos.length) {
      return false
    }
    const seen = new Set<string>()
    const reorderedHostRepos: Repo[] = []
    for (const id of orderedIds) {
      const repo = typeof id === 'string' && !seen.has(id) ? byId.get(id) : undefined
      if (!repo) {
        return false
      }
      seen.add(id)
      reorderedHostRepos.push(repo)
    }
    let nextHostIndex = 0
    this.state.repos = current.map((repo) =>
      getRepoExecutionHostId(repo) === hostId ? reorderedHostRepos[nextHostIndex++] : repo
    )
    this.syncProjectHostSetupCompatibilityState()
    this.scheduleSave()
    return true
  }
}
