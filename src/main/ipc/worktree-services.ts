import { basename } from 'node:path'
import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { loadHooks } from '../hooks'
import { provisionWorktreeServices } from '../worktree-services'
import { listWorktreeServicesRecords } from '../../shared/worktree-services-store'
import type { WorktreeServicesRecord } from '../../shared/worktree-services'
import { parseWorktreeId } from './worktree-logic'

export function registerWorktreeServicesHandlers(store: Store): void {
  ipcMain.removeHandler('worktreeServices:list')
  ipcMain.removeHandler('worktreeServices:retry')

  ipcMain.handle('worktreeServices:list', (): WorktreeServicesRecord[] =>
    listWorktreeServicesRecords(app.getPath('userData'))
  )

  ipcMain.handle(
    'worktreeServices:retry',
    async (event, args: { worktreeId: string }): Promise<WorktreeServicesRecord> => {
      const { repoId, worktreePath } = parseWorktreeId(args.worktreeId)
      const repo = store.getRepo(repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${repoId}`)
      }
      // Why: v1 provisions local + WSL worktrees only; remote repos never opt in.
      if (repo.connectionId) {
        throw new Error('Service provisioning is not supported for remote repositories.')
      }
      const services = loadHooks(repo.path)?.services ?? []
      const worktreeName =
        store.getWorktreeMeta(args.worktreeId)?.displayName ?? basename(worktreePath)
      return provisionWorktreeServices({
        userDataPath: app.getPath('userData'),
        worktreeId: args.worktreeId,
        worktreeName,
        worktreePath,
        repo,
        services,
        onEvent: (provisionEvent) =>
          event.sender.send('worktreeServices:provisionEvent', provisionEvent)
      })
    }
  )
}
