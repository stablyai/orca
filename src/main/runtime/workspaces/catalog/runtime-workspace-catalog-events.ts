import { getRepoRoutingConnectionId } from '../../../../shared/execution-host'
import { OrcaRuntimeWithGetStatus } from '../../orca-runtime-get-status'

export abstract class RuntimeWorkspaceCatalogEvents extends OrcaRuntimeWithGetStatus {
  abstract invalidateResolvedWorktreeCache(): void

  abstract invalidateWorktreeScanCacheForRepo(repoId: string): void

  // Renderer meta writes skip its notifier after optimistic updates; remote clients still need invalidation.
  notifyWorktreesChangedForRemoteClients(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  /** A background removal started or ended; every client refetches and reads the `removing` marker. */
  publishWorktreeRemovalChange(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.notifyWorktreesChanged(repoId)
  }

  // Catalog changes need fresh Git scans; metadata-only edits do not.
  notifyWorktreeCatalogChangedForRemoteClients(repoId: string): void {
    this.invalidateWorktreeScanCacheForRepo(repoId)
    const matchingRepos = this.store?.getRepos().filter((repo) => repo.id === repoId) ?? []
    if (matchingRepos.length !== 1 || getRepoRoutingConnectionId(matchingRepos[0])) {
      return
    }
    this.notifyWorktreesChangedForRemoteClients(repoId)
  }

  // Host repo IPC bypasses runtime methods; invalidate paired clients without duplicating local repos:changed (#11994).
  notifyReposChangedForRemoteClients(): void {
    this.emitClientEvent({ type: 'reposChanged' })
  }
}
