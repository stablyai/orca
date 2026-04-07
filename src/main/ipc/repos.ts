import type { BrowserWindow } from 'electron'
import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/types'
import { isFolderRepo } from '../../shared/repo-kind'
import { REPO_COLORS } from '../../shared/constants'
import { rebuildAuthorizedRootsCache } from './filesystem-auth'
import { spawn } from 'child_process'
import { join, basename } from 'path'
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
  ipcMain.removeHandler('repos:pickDirectory')
  ipcMain.removeHandler('repos:clone')
  ipcMain.removeHandler('repos:getGitUsername')
  ipcMain.removeHandler('repos:getBaseRefDefault')
  ipcMain.removeHandler('repos:searchBaseRefs')

  ipcMain.handle('repos:list', () => {
    return store.getRepos()
  })

  ipcMain.handle('repos:add', async (_event, args: { path: string; kind?: 'git' | 'folder' }) => {
    const repoKind = args.kind === 'folder' ? 'folder' : 'git'
    if (repoKind === 'git' && !isGitRepo(args.path)) {
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
      addedAt: Date.now(),
      kind: repoKind
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
          Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef' | 'kind'>
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

  // Why: pickDirectory is a generic "choose a folder" picker, separate from
  // pickFolder which is specifically the "add repo" flow. Clone needs a
  // destination directory that may not be a git repo yet.
  ipcMain.handle('repos:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle(
    'repos:clone',
    async (_event, args: { url: string; destination: string }): Promise<Repo> => {
      // Why: the user picks a parent directory (e.g. ~/projects) and we derive
      // the repo folder name from the URL (e.g. "orca" from .../orca.git).
      // This matches the default git clone behavior where the last path segment
      // of the URL becomes the directory name.
      const repoName = basename(args.url.replace(/\.git\/?$/, ''))
      if (!repoName) {
        throw new Error('Could not determine repository name from URL')
      }
      const clonePath = join(args.destination, repoName)

      // Why: use spawn instead of execFile so there is no maxBuffer limit.
      // git clone writes progress to stderr which can exceed Node's default
      // 1 MB buffer on large or submodule-heavy repos. We only keep the tail
      // of stderr for error reporting and discard stdout entirely.
      // Why: use --progress to force git to emit progress even when stderr
      // is not a TTY. Without it, git suppresses progress output when piped.
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['clone', '--progress', args.url, clonePath], {
          stdio: ['ignore', 'ignore', 'pipe']
        })

        let stderrTail = ''
        proc.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString()
          stderrTail = (stderrTail + text).slice(-4096)

          // Why: git progress lines use \r to overwrite in-place. Split on
          // both \r and \n to find the latest progress fragment, then extract
          // the phase name and percentage for the renderer.
          const lines = text.split(/[\r\n]+/)
          for (const line of lines) {
            const match = line.match(/^([\w\s]+):\s+(\d+)%/)
            if (match && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('repos:clone-progress', {
                phase: match[1].trim(),
                percent: parseInt(match[2], 10)
              })
            }
          }
        })

        proc.on('error', (err) => reject(new Error(`Clone failed: ${err.message}`)))

        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            const lastLine = stderrTail.trim().split('\n').pop() ?? 'unknown error'
            reject(new Error(`Clone failed: ${lastLine}`))
          }
        })
      })

      // After cloning, add the repo the same way repos:add does
      const existing = store.getRepos().find((r) => r.path === clonePath)
      if (existing) {
        return existing
      }

      const repo: Repo = {
        id: randomUUID(),
        path: clonePath,
        displayName: getRepoName(clonePath),
        badgeColor: REPO_COLORS[store.getRepos().length % REPO_COLORS.length],
        addedAt: Date.now(),
        kind: 'git'
      }

      store.addRepo(repo)
      await rebuildAuthorizedRootsCache(store)
      notifyReposChanged(mainWindow)
      return repo
    }
  )

  ipcMain.handle('repos:getGitUsername', (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return ''
    }
    return getGitUsername(repo.path)
  })

  ipcMain.handle('repos:getBaseRefDefault', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return 'origin/main'
    }
    return getBaseRefDefault(repo.path)
  })

  ipcMain.handle(
    'repos:searchBaseRefs',
    async (_event, args: { repoId: string; query: string; limit?: number }) => {
      const repo = store.getRepo(args.repoId)
      if (!repo || isFolderRepo(repo)) {
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
