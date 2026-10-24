import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import type { Project, ProjectUpdateArgs } from '../../../shared/project-types'
import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { enrichRepoGitUsernames } from '../../repo-git-username-enrichment'
import { enrichMissingRepoGitRemoteIdentities } from '../../repo-git-remote-identity-enrichment'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
import { notifyReposChanged } from './repos-changed-notification'
import { scheduleCurrentWorktreeBaseDirectoryWatcherSync } from '../worktree-base-directory-watcher'
import { ProjectUpdateIpcArgs, parseProjectGroupIpcArgs } from './repo-ipc-arg-schemas'
import { visibleProjectHostSetups, visibleRepos } from '../../ssh/orcad-retained-source'
import {
  assertWslMoveProjectWritable,
  assertWslMoveReposWritable,
  isWslMoveSourceHost
} from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'

export function registerRepoCatalogHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: Pick<OrcaRuntimeService, 'removeProject'>
): void {
  // Enrichment deduplicates by callback identity; per-call closures accumulate broadcasts during slow sweeps.
  const broadcastReposChanged = (): void => notifyReposChanged(mainWindow)

  ipcMain.handle('repos:list', () => {
    enrichMissingRepoGitRemoteIdentities(store, { onChanged: broadcastReposChanged })
    // Git/gh username discovery must not block synchronous listing; completion triggers a refresh (#7225).
    enrichRepoGitUsernames(store, { onChanged: broadcastReposChanged })
    return visibleRepos(store)
  })

  ipcMain.handle('projects:list', () => {
    enrichMissingRepoGitRemoteIdentities(store, { onChanged: broadcastReposChanged })
    return store.getProjects()
  })

  ipcMain.handle('projects:update', (_event, rawArgs: ProjectUpdateArgs): Project | null => {
    const args = parseProjectGroupIpcArgs(
      ProjectUpdateIpcArgs,
      rawArgs,
      'project_update_invalid_args'
    )
    const project = store.getProjects().find((entry) => entry.id === args.projectId)
    assertWslMoveReposWritable(store, project?.sourceRepoIds ?? [])
    return store.updateProject(args.projectId, args.updates)
  })

  ipcMain.handle('projectHostSetups:list', () => {
    enrichMissingRepoGitRemoteIdentities(store, { onChanged: broadcastReposChanged })
    return visibleProjectHostSetups(store)
  })

  ipcMain.handle(
    'repos:reorder',
    (_event, args: { orderedIds: string[] }): { status: 'applied' | 'rejected' } => {
      // Reject stale drag permutations so the renderer can resync after concurrent changes.
      const ids = Array.isArray(args?.orderedIds) ? args.orderedIds : []
      const applied = store.reorderRepos(ids)
      if (applied) {
        notifyReposChanged(mainWindow)
        return { status: 'applied' }
      }
      return { status: 'rejected' }
    }
  )

  ipcMain.handle(
    'repos:reorderForHost',
    (
      _event,
      args: { orderedIds: string[]; hostId: string }
    ): { status: 'applied' | 'rejected' } => {
      const hostId = normalizeExecutionHostId(args?.hostId)
      if (!hostId) {
        return { status: 'rejected' }
      }
      const ids = Array.isArray(args?.orderedIds) ? args.orderedIds : []
      const applied = store.reorderReposForHost(ids, hostId)
      if (applied) {
        notifyReposChanged(mainWindow)
        return { status: 'applied' }
      }
      return { status: 'rejected' }
    }
  )

  // Removal is host-scoped because repo IDs can collide.
  ipcMain.handle(
    'repos:removeForHost',
    async (_event, args: { repoId: string; hostId: string }) => {
      const hostId = normalizeExecutionHostId(args.hostId)
      if (!hostId) {
        throw new Error(`Invalid host ID: ${args.hostId}`)
      }
      if (isWslMoveSourceHost(hostId)) {
        assertWslMoveProjectWritable(store, { repoId: args.repoId })
      }
      const row = store
        .getRepos()
        .find((repo) => repo.id === args.repoId && getRepoExecutionHostId(repo) === hostId)
      // Runtime sweeps stop local/SSH sessions absent from renderer listings; paired-server rows are residue.
      if (row && parseExecutionHostId(hostId)?.kind !== 'runtime') {
        await runtime.removeProject(row)
        scheduleCurrentWorktreeBaseDirectoryWatcherSync()
        return
      }
      store.removeProjectForHost({ id: args.repoId, executionHostId: hostId })
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
    }
  )
}
