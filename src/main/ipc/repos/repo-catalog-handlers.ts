import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import type { Project, ProjectUpdateArgs } from '../../../shared/project-types'
import type {
  HostRepoCatalogSnapshot,
  ListReposForExecutionHostArgs
} from '../../../shared/host-repo-catalog-contract'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import { enrichRepoGitUsernames } from '../../repo-git-username-enrichment'
import { enrichMissingRepoGitRemoteIdentities } from '../../repo-git-remote-identity-enrichment'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
import { notifyReposChanged } from './repos-changed-notification'
import { ProjectUpdateIpcArgs, parseProjectGroupIpcArgs } from './repo-ipc-arg-schemas'
import { listReposForExecutionHost } from './host-repo-catalog-snapshot'

export function registerRepoCatalogHandlers(mainWindow: BrowserWindow, store: Store): void {
  // Why one shared reference: enrichment dedupes coalesced callers by callback identity, so a fresh
  // closure per list call would stack up (and re-broadcast) for the length of a slow sweep.
  const broadcastReposChanged = (): void => notifyReposChanged(mainWindow)

  ipcMain.handle('repos:list', () => {
    enrichMissingRepoGitRemoteIdentities(store, { onChanged: broadcastReposChanged })
    // Why: username resolution spawns git/gh, so keep it off this sync handler (issue #7225); it re-lists when values land.
    enrichRepoGitUsernames(store, { onChanged: broadcastReposChanged })
    return store.getRepos()
  })

  ipcMain.handle(
    'repos:listForExecutionHost',
    (_event, args: ListReposForExecutionHostArgs): Promise<HostRepoCatalogSnapshot> =>
      listReposForExecutionHost(store, args)
  )

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
    return store.updateProject(args.projectId, args.updates)
  })

  ipcMain.handle('projectHostSetups:list', () => {
    enrichMissingRepoGitRemoteIdentities(store, { onChanged: broadcastReposChanged })
    return store.getProjectHostSetups()
  })

  ipcMain.handle(
    'repos:reorder',
    (_event, args: { orderedIds: string[] }): { status: 'applied' | 'rejected' } => {
      // Why: a permutation mismatch means the renderer's drag was stale vs a concurrent add/remove; reject so it can resync.
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

  ipcMain.handle('repos:remove', async (_event, args: { repoId: string }) => {
    store.removeProject(args.repoId)
    invalidateAuthorizedRootsCache()
    notifyReposChanged(mainWindow)
  })

  // Why: forget a project on one execution host without disturbing the same repo id on other hosts (SSH-workspace forget flow).
  ipcMain.handle(
    'repos:removeForHost',
    async (_event, args: { repoId: string; hostId: string }) => {
      const hostId = normalizeExecutionHostId(args.hostId)
      if (!hostId) {
        throw new Error(`Invalid host ID: ${args.hostId}`)
      }
      store.removeProjectForHost(args.repoId, hostId)
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
    }
  )
}
