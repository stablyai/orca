import type { BrowserWindow } from 'electron'
import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/types'
import { REPO_COLORS } from '../../shared/constants'
import { rebuildAuthorizedRootsCache } from './filesystem-auth'
import {
  isGitRepo,
  getGitUsername,
  getRepoName,
  getBaseRefDefault,
  searchBaseRefs
} from '../git/repo'

export function registerRepoHandlers(mainWindow: BrowserWindow, store: Store): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('repos:list')
  ipcMain.removeHandler('repos:add')
  ipcMain.removeHandler('repos:remove')
  ipcMain.removeHandler('repos:update')
  ipcMain.removeHandler('repos:pickFolder')
  ipcMain.removeHandler('repos:getGitUsername')
  ipcMain.removeHandler('repos:getBaseRefDefault')
  ipcMain.removeHandler('repos:searchBaseRefs')

  ipcMain.handle('repos:list', () => {
    return store.getRepos()
  })

  ipcMain.handle('repos:add', async (_event, args: { path: string }) => {
    if (!isGitRepo(args.path)) {
      throw new Error(`Not a valid git repository: ${args.path}`)
    }

    // Check if already added
    const existing = store.getRepos().find((r) => r.path === args.path)
    if (existing) {
      return existing
    }

    const repo: Repo = {
      id: randomUUID(),
      path: args.path,
      displayName: getRepoName(args.path),
      badgeColor: REPO_COLORS[store.getRepos().length % REPO_COLORS.length],
      addedAt: Date.now()
    }

    store.addRepo(repo)
    await rebuildAuthorizedRootsCache(store)
    notifyReposChanged(mainWindow)
    return repo
  })

  ipcMain.handle('repos:remove', async (_event, args: { repoId: string }) => {
    store.removeRepo(args.repoId)
    await rebuildAuthorizedRootsCache(store)
    notifyReposChanged(mainWindow)
  })

  ipcMain.handle(
    'repos:update',
    (
      _event,
      args: {
        repoId: string
        updates: Partial<
          Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef'>
        >
      }
    ) => {
      const updated = store.updateRepo(args.repoId, args.updates)
      if (updated) {
        notifyReposChanged(mainWindow)
      }
      return updated
    }
  )

  ipcMain.handle('repos:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('repos:getGitUsername', (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      return ''
    }
    return getGitUsername(repo.path)
  })

  ipcMain.handle('repos:getBaseRefDefault', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      return 'origin/main'
    }
    return getBaseRefDefault(repo.path)
  })

  ipcMain.handle(
    'repos:searchBaseRefs',
    async (_event, args: { repoId: string; query: string; limit?: number }) => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return []
      }
      return searchBaseRefs(repo.path, args.query, args.limit ?? 25)
    }
  )
}

function notifyReposChanged(mainWindow: BrowserWindow): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('repos:changed')
  }
}
