import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { composeWorktreeId } from '../../../../shared/worktree/id'
import type { PullRequestChange } from '../../../github/pull-request-changed-events'
import { OrcaRuntimeWithGetStatus } from '../../hosts/runtime-status'

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
    if (this.soleLocalRepo(repoId)) {
      this.notifyWorktreesChangedForRemoteClients(repoId)
    }
  }

  /** The base-dir watcher saw index, HEAD or ref moves; `worktreePaths` null means any checkout. */
  notifyGitStatusChangedForRemoteClients(
    repoId: string,
    worktreePaths: readonly string[] | null
  ): void {
    const repo = this.soleLocalRepo(repoId)
    if (!repo) {
      return
    }
    const worktreeIds = worktreePaths && this.listedWorktreeIds(repo, worktreePaths)
    this.emitClientEvent({ type: 'gitStatusChanged', repoId, ...(worktreeIds && { worktreeIds }) })
  }

  // Watcher events carry only a repo id, so one shared with an SSH repo would be owner-blind.
  private soleLocalRepo(repoId: string): Repo | null {
    const matchingRepos = this.store?.getRepos().filter((repo) => repo.id === repoId) ?? []
    return matchingRepos.length === 1 && !getRepoRoutingConnectionId(matchingRepos[0])
      ? matchingRepos[0]
      : null
  }

  // Ids spelled as clients listed them; an unlisted path may be another spelling of any checkout, so name none.
  private listedWorktreeIds(repo: Repo, paths: readonly string[]): string[] | null {
    const scan = this.worktreeScanCache.get(`${repo.id}\0${getRepoExecutionHostId(repo)}`)
    const listed = new Map(
      (scan?.listing ?? scan?.result)?.worktrees.map((worktree) => [
        normalizeRuntimePathForComparison(worktree.path),
        worktree.path
      ])
    )
    const ids: string[] = []
    for (const path of paths) {
      const listedPath = listed.get(normalizeRuntimePathForComparison(path))
      if (listedPath === undefined) {
        return null
      }
      ids.push(composeWorktreeId(repo.id, listedPath))
    }
    return ids
  }

  // Host repo IPC bypasses runtime methods; invalidate paired clients without duplicating local repos:changed (#11994).
  notifyReposChangedForRemoteClients(): void {
    this.emitClientEvent({ type: 'reposChanged' })
  }

  // The PR coordinator is fed by desktop IPC, so its refreshes reach paired clients only through here.
  notifyPullRequestChangedForRemoteClients(change: PullRequestChange): void {
    this.emitClientEvent({ type: 'pullRequestChanged', ...change })
  }
}
