import type { BrowserWindow } from 'electron'
import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/types'
import { isFolderRepo } from '../../shared/repo-kind'
import { REPO_COLORS } from '../../shared/constants'
import { rebuildAuthorizedRootsCache } from './filesystem-auth'
import type { ChildProcess } from 'child_process'
import { rm } from 'fs/promises'
import { gitSpawn } from '../git/runner'
import { join, basename } from 'path'
import {
  isGitRepo,
  getGitUsername,
  getRepoName,
  getBaseRefDefault,
  searchBaseRefs
} from '../git/repo'

// Why: module-scoped so the abort handle survives window re-creation on macOS.
// registerRepoHandlers is called again when a new BrowserWindow is created,
// and a function-scoped variable would lose the reference to an in-flight clone.
let activeCloneProc: ChildProcess | null = null
let activeClonePath: string | null = null

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
  ipcMain.removeHandler('repos:cloneAbort')
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

  ipcMain.handle('repos:cloneAbort', async () => {
    if (activeCloneProc) {
      const pathToClean = activeClonePath
      activeCloneProc.kill()
      activeCloneProc = null
      activeClonePath = null
      // Why: git clone creates the target directory before it finishes.
      // Without cleanup, retrying the same URL/destination fails with
      // "destination path already exists and is not an empty directory".
      if (pathToClean) {
        await rm(pathToClean, { recursive: true, force: true }).catch(() => {
          // Best-effort cleanup — don't fail the abort if removal fails
        })
      }
    }
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
        // Why: clone destination may be a WSL path (e.g. user picks a WSL
        // directory). Use the parent destination as the cwd so the runner
        // detects WSL and routes through wsl.exe.
        const proc = gitSpawn(['clone', '--progress', args.url, clonePath], {
          cwd: args.destination,
          stdio: ['ignore', 'ignore', 'pipe']
        })
        activeCloneProc = proc
        activeClonePath = clonePath

        let stderrTail = ''
        proc.stderr!.on('data', (chunk: Buffer) => {
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

        proc.on('close', (code, signal) => {
          // Why: only clear the ref if it still points to this process.
          // A quick abort-and-retry can reassign activeCloneProc to a new
          // spawn before this handler fires, and nulling it would make the
          // new clone unabortable.
          if (activeCloneProc === proc) {
            activeCloneProc = null
            activeClonePath = null
          }
          if (signal === 'SIGTERM') {
            reject(new Error('Clone aborted'))
          } else if (code === 0) {
            resolve()
          } else {
            const lastLine = stderrTail.trim().split('\n').pop() ?? 'unknown error'
            reject(new Error(`Clone failed: ${lastLine}`))
          }
        })
      })

      // Why: check after clone (not before) because the path didn't exist
      // before cloning. But if the user somehow had a folder repo at this path
      // that git clone succeeded into (empty dir), reuse that entry and upgrade
      // its kind to 'git' instead of creating a duplicate.
      const existing = store.getRepos().find((r) => r.path === clonePath)
      if (existing) {
        if (isFolderRepo(existing)) {
          const updated = store.updateRepo(existing.id, { kind: 'git' })
          if (updated) {
            notifyReposChanged(mainWindow)
            return updated
          }
        }
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
