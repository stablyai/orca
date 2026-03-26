import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { execFileSync } from 'child_process'
import { rm } from 'fs/promises'
import type { Store } from '../persistence'
import type { Worktree, WorktreeMeta } from '../../shared/types'
import { listWorktrees, addWorktree, removeWorktree } from '../git/worktree'
import { getGitUsername, getDefaultBaseRef, getAvailableBranchName } from '../git/repo'
import { getEffectiveHooks, loadHooks, runHook, hasHooksFile } from '../hooks'
import {
  sanitizeWorktreeName,
  computeBranchName,
  computeWorktreePath,
  ensurePathWithinWorkspace,
  shouldSetDisplayName,
  mergeWorktree,
  parseWorktreeId,
  formatWorktreeRemovalError,
  isOrphanedWorktreeError
} from './worktree-logic'

export function registerWorktreeHandlers(mainWindow: BrowserWindow, store: Store): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('worktrees:listAll')
  ipcMain.removeHandler('worktrees:list')
  ipcMain.removeHandler('worktrees:create')
  ipcMain.removeHandler('worktrees:remove')
  ipcMain.removeHandler('worktrees:updateMeta')
  ipcMain.removeHandler('hooks:check')

  ipcMain.handle('worktrees:listAll', async () => {
    const repos = store.getRepos()
    const allWorktrees: Worktree[] = []

    for (const repo of repos) {
      const gitWorktrees = await listWorktrees(repo.path)
      for (const gw of gitWorktrees) {
        const worktreeId = `${repo.id}::${gw.path}`
        const meta = store.getWorktreeMeta(worktreeId)
        allWorktrees.push(mergeWorktree(repo.id, gw, meta))
      }
    }

    return allWorktrees
  })

  ipcMain.handle('worktrees:list', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      return []
    }

    const gitWorktrees = await listWorktrees(repo.path)
    return gitWorktrees.map((gw) => {
      const worktreeId = `${repo.id}::${gw.path}`
      const meta = store.getWorktreeMeta(worktreeId)
      return mergeWorktree(repo.id, gw, meta)
    })
  })

  ipcMain.handle(
    'worktrees:create',
    async (_event, args: { repoId: string; name: string; baseBranch?: string }) => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${args.repoId}`)
      }

      const settings = store.getSettings()

      const requestedName = args.name
      const sanitizedName = sanitizeWorktreeName(args.name)

      // Compute branch name with prefix
      const username = getGitUsername(repo.path)
      let branchName = computeBranchName(sanitizedName, settings, username)
      branchName = await getAvailableBranchName(repo.path, branchName)

      // Compute worktree path
      let worktreePath = computeWorktreePath(sanitizedName, repo.path, settings)
      worktreePath = ensurePathWithinWorkspace(worktreePath, settings.workspaceDir)

      // Determine base branch
      const baseBranch = args.baseBranch || repo.worktreeBaseRef || getDefaultBaseRef(repo.path)

      // Fetch latest from remote so the worktree starts with up-to-date content
      const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
      try {
        execFileSync('git', ['fetch', remote], {
          cwd: repo.path,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch {
        // Fetch is best-effort — don't block worktree creation if offline
      }

      addWorktree(repo.path, worktreePath, branchName, baseBranch)

      // Re-list to get the freshly created worktree info
      const gitWorktrees = await listWorktrees(repo.path)
      const created = gitWorktrees.find((gw) => gw.path === worktreePath)
      if (!created) {
        throw new Error('Worktree created but not found in listing')
      }

      const worktreeId = `${repo.id}::${worktreePath}`
      const metaUpdates: Partial<WorktreeMeta> = shouldSetDisplayName(
        requestedName,
        branchName,
        sanitizedName
      )
        ? { displayName: requestedName }
        : {}
      const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
      const worktree = mergeWorktree(repo.id, created, meta)

      // Run setup hook asynchronously (don't block the UI)
      const hooks = getEffectiveHooks(repo)
      if (hooks?.scripts.setup) {
        runHook('setup', worktreePath, repo).then((result) => {
          if (!result.success) {
            console.error(`[hooks] setup hook failed for ${worktreePath}:`, result.output)
          }
        })
      }

      notifyWorktreesChanged(mainWindow, repo.id)
      return worktree
    }
  )

  ipcMain.handle(
    'worktrees:remove',
    async (_event, args: { worktreeId: string; force?: boolean }) => {
      const { repoId, worktreePath } = parseWorktreeId(args.worktreeId)
      const repo = store.getRepo(repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${repoId}`)
      }

      // Run archive hook before removal
      const hooks = getEffectiveHooks(repo)
      if (hooks?.scripts.archive) {
        const result = await runHook('archive', worktreePath, repo)
        if (!result.success) {
          console.error(`[hooks] archive hook failed for ${worktreePath}:`, result.output)
        }
      }

      try {
        await removeWorktree(repo.path, worktreePath, args.force ?? false)
      } catch (error) {
        // If git no longer tracks this worktree, clean up the directory and metadata
        if (isOrphanedWorktreeError(error)) {
          console.warn(`[worktrees] Orphaned worktree detected at ${worktreePath}, cleaning up`)
          await rm(worktreePath, { recursive: true, force: true }).catch(() => {})
          store.removeWorktreeMeta(args.worktreeId)
          notifyWorktreesChanged(mainWindow, repoId)
          return
        }
        throw new Error(formatWorktreeRemovalError(error, worktreePath, args.force ?? false))
      }
      store.removeWorktreeMeta(args.worktreeId)

      notifyWorktreesChanged(mainWindow, repoId)
    }
  )

  ipcMain.handle(
    'worktrees:updateMeta',
    (_event, args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => {
      const meta = store.setWorktreeMeta(args.worktreeId, args.updates)
      const { repoId } = parseWorktreeId(args.worktreeId)
      notifyWorktreesChanged(mainWindow, repoId)
      return meta
    }
  )

  ipcMain.handle('hooks:check', (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      return { hasHooks: false, hooks: null }
    }

    const has = hasHooksFile(repo.path)
    const hooks = has ? loadHooks(repo.path) : null
    return {
      hasHooks: has,
      hooks
    }
  })
}

function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:changed', { repoId })
  }
}
