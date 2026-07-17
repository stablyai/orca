import { basename } from 'node:path'
import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import {
  getWorktreeServicesRuntime,
  loadServiceRecipesForWorktree,
  provisionWorktreeServices,
  runWorktreeServiceAction
} from '../worktree-services'
import { listWorktreeServicesRecords } from '../../shared/worktree-services-store'
import type {
  WorktreeServiceRuntimeState,
  WorktreeServicesRecord
} from '../../shared/worktree-services'
import type { OrcaServiceRecipe, Repo } from '../../shared/types'
import { parseWorktreeId } from './worktree-logic'

function resolveServicesContext(
  store: Store,
  worktreeId: string
): { repo: Repo; worktreePath: string; services: OrcaServiceRecipe[] } {
  const { repoId, worktreePath } = parseWorktreeId(worktreeId)
  const repo = store.getRepo(repoId)
  if (!repo) {
    throw new Error(`Repo not found: ${repoId}`)
  }
  // Why: v1 provisions local + WSL worktrees only; remote repos never opt in.
  if (repo.connectionId) {
    throw new Error('Isolated services are not supported for remote repositories.')
  }
  return { repo, worktreePath, services: loadServiceRecipesForWorktree(worktreePath, repo.path) }
}

export function registerWorktreeServicesHandlers(store: Store): void {
  ipcMain.removeHandler('worktreeServices:list')
  ipcMain.removeHandler('worktreeServices:retry')
  ipcMain.removeHandler('worktreeServices:runtime')
  ipcMain.removeHandler('worktreeServices:action')

  ipcMain.handle('worktreeServices:list', (): WorktreeServicesRecord[] =>
    listWorktreeServicesRecords(app.getPath('userData'))
  )

  // Why: the card badge retry has no disabled state; a double-click must join
  // the in-flight provision instead of racing two create runs on one slug.
  const retriesInFlight = new Map<string, Promise<WorktreeServicesRecord>>()
  ipcMain.handle(
    'worktreeServices:retry',
    async (event, args: { worktreeId: string }): Promise<WorktreeServicesRecord> => {
      const inFlight = retriesInFlight.get(args.worktreeId)
      if (inFlight) {
        return inFlight
      }
      const { repo, worktreePath, services } = resolveServicesContext(store, args.worktreeId)
      const worktreeName =
        store.getWorktreeMeta(args.worktreeId)?.displayName ?? basename(worktreePath)
      const retry = provisionWorktreeServices({
        userDataPath: app.getPath('userData'),
        worktreeId: args.worktreeId,
        worktreeName,
        worktreePath,
        repo,
        services,
        onEvent: (provisionEvent) =>
          event.sender.send('worktreeServices:provisionEvent', provisionEvent)
      }).finally(() => retriesInFlight.delete(args.worktreeId))
      retriesInFlight.set(args.worktreeId, retry)
      return retry
    }
  )

  ipcMain.handle(
    'worktreeServices:runtime',
    async (_event, args: { worktreeId: string }): Promise<WorktreeServiceRuntimeState[]> => {
      const { worktreePath, services } = resolveServicesContext(store, args.worktreeId)
      return getWorktreeServicesRuntime({
        userDataPath: app.getPath('userData'),
        worktreeId: args.worktreeId,
        worktreePath,
        services
      })
    }
  )

  ipcMain.handle(
    'worktreeServices:action',
    async (
      _event,
      args: { worktreeId: string; action: 'start' | 'stop'; serviceId?: string }
    ): Promise<{ success: boolean; errors: string[] }> => {
      const { worktreePath, services } = resolveServicesContext(store, args.worktreeId)
      return runWorktreeServiceAction({
        userDataPath: app.getPath('userData'),
        worktreeId: args.worktreeId,
        worktreePath,
        services,
        action: args.action,
        ...(args.serviceId ? { serviceId: args.serviceId } : {})
      })
    }
  )
}
