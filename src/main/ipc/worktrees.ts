import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { join, basename, resolve, relative, isAbsolute } from 'path'
import type { Store } from '../persistence'
import type { Worktree, WorktreeMeta } from '../../shared/types'
import { listWorktrees, addWorktree, removeWorktree } from '../git/worktree'
import { getGitUsername, getDefaultBaseRef, getAvailableBranchName } from '../git/repo'
import { getEffectiveHooks, loadHooks, runHook, hasHooksFile } from '../hooks'

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
      let branchName = sanitizedName
      if (settings.branchPrefix === 'git-username') {
        const username = getGitUsername(repo.path)
        if (username) {
          branchName = `${username}/${sanitizedName}`
        }
      } else if (settings.branchPrefix === 'custom' && settings.branchPrefixCustom) {
        branchName = `${settings.branchPrefixCustom}/${sanitizedName}`
      }

      branchName = await getAvailableBranchName(repo.path, branchName)

      // Compute worktree path
      let worktreePath: string
      if (settings.nestWorkspaces) {
        const repoName = basename(repo.path).replace(/\.git$/, '')
        worktreePath = join(settings.workspaceDir, repoName, sanitizedName)
      } else {
        worktreePath = join(settings.workspaceDir, sanitizedName)
      }
      worktreePath = ensurePathWithinWorkspace(worktreePath, settings.workspaceDir)

      // Determine base branch
      const baseBranch = args.baseBranch || repo.worktreeBaseRef || getDefaultBaseRef(repo.path)

      addWorktree(repo.path, worktreePath, branchName, baseBranch)

      // Re-list to get the freshly created worktree info
      const gitWorktrees = await listWorktrees(repo.path)
      const created = gitWorktrees.find((gw) => gw.path === worktreePath)
      if (!created) {
        throw new Error('Worktree created but not found in listing')
      }

      const worktreeId = `${repo.id}::${worktreePath}`
      const metaUpdates: Partial<WorktreeMeta> =
        branchName === requestedName && sanitizedName === requestedName
          ? {}
          : { displayName: requestedName }
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

function mergeWorktree(
  repoId: string,
  git: { path: string; head: string; branch: string; isBare: boolean },
  meta: WorktreeMeta | undefined
): Worktree {
  const branchShort = git.branch.replace(/^refs\/heads\//, '')
  return {
    id: `${repoId}::${git.path}`,
    repoId,
    path: git.path,
    head: git.head,
    branch: git.branch,
    isBare: git.isBare,
    displayName: meta?.displayName || branchShort || basename(git.path),
    comment: meta?.comment || '',
    linkedIssue: meta?.linkedIssue ?? null,
    linkedPR: meta?.linkedPR ?? null,
    isArchived: meta?.isArchived ?? false,
    isUnread: meta?.isUnread ?? false,
    sortOrder: meta?.sortOrder ?? 0
  }
}

function sanitizeWorktreeName(input: string): string {
  const sanitized = input
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid worktree name')
  }

  return sanitized
}

function ensurePathWithinWorkspace(targetPath: string, workspaceDir: string): string {
  const resolvedWorkspaceDir = resolve(workspaceDir)
  const resolvedTargetPath = resolve(targetPath)
  const rel = relative(resolvedWorkspaceDir, resolvedTargetPath)

  if (isAbsolute(rel) || rel.startsWith('..')) {
    throw new Error('Invalid worktree path')
  }

  return resolvedTargetPath
}

function parseWorktreeId(worktreeId: string): { repoId: string; worktreePath: string } {
  const sepIdx = worktreeId.indexOf('::')
  if (sepIdx === -1) {
    throw new Error(`Invalid worktreeId: ${worktreeId}`)
  }
  return {
    repoId: worktreeId.slice(0, sepIdx),
    worktreePath: worktreeId.slice(sepIdx + 2)
  }
}

function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:changed', { repoId })
  }
}

function formatWorktreeRemovalError(error: unknown, worktreePath: string, force: boolean): string {
  const fallback = force
    ? `Failed to force delete worktree at ${worktreePath}.`
    : `Failed to delete worktree at ${worktreePath}.`

  if (!(error instanceof Error)) {
    return fallback
  }

  const errorWithStreams = error as Error & { stderr?: string; stdout?: string }
  const details = [errorWithStreams.stderr, errorWithStreams.stdout, error.message]
    .map((value) => value?.trim())
    .find(Boolean)

  return details ? `${fallback} ${details}` : fallback
}
