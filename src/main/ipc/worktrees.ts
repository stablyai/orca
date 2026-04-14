import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { rm } from 'fs/promises'
import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import { deleteWorktreeHistoryDir } from '../terminal-history'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  Worktree,
  WorktreeMeta
} from '../../shared/types'
import { removeWorktree } from '../git/worktree'
import { gitExecFileAsync } from '../git/runner'
import { listRepoWorktrees, createFolderWorktree } from '../repo-worktrees'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  createIssueCommandRunnerScript,
  getEffectiveHooks,
  loadHooks,
  readIssueCommand,
  runHook,
  hasHooksFile,
  hasUnrecognizedOrcaYamlKeys,
  writeIssueCommand
} from '../hooks'
import {
  mergeWorktree,
  parseWorktreeId,
  formatWorktreeRemovalError,
  isOrphanedWorktreeError
} from './worktree-logic'
import {
  createLocalWorktree,
  createRemoteWorktree,
  notifyWorktreesChanged
} from './worktree-remote'
import { rebuildAuthorizedRootsCache, ensureAuthorizedRootsCache } from './filesystem-auth'

export function registerWorktreeHandlers(mainWindow: BrowserWindow, store: Store): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('worktrees:listAll')
  ipcMain.removeHandler('worktrees:list')
  ipcMain.removeHandler('worktrees:create')
  ipcMain.removeHandler('worktrees:remove')
  ipcMain.removeHandler('worktrees:updateMeta')
  ipcMain.removeHandler('worktrees:persistSortOrder')
  ipcMain.removeHandler('hooks:check')
  ipcMain.removeHandler('hooks:createIssueCommandRunner')
  ipcMain.removeHandler('hooks:readIssueCommand')
  ipcMain.removeHandler('hooks:writeIssueCommand')

  ipcMain.handle('worktrees:listAll', async () => {
    // Why: use ensureAuthorizedRootsCache (not rebuild) to avoid redundantly
    // listing git worktrees when the cache is already fresh — the handler
    // itself calls listWorktrees for every repo below.
    await ensureAuthorizedRootsCache(store)
    const repos = store.getRepos()
    const allWorktrees: Worktree[] = []

    for (const repo of repos) {
      let gitWorktrees
      if (isFolderRepo(repo)) {
        gitWorktrees = [createFolderWorktree(repo)]
      } else if (repo.connectionId) {
        const provider = getSshGitProvider(repo.connectionId)
        // Why: when SSH is disconnected the provider is null. Skip this repo
        // so the renderer keeps its cached worktree list instead of clearing it.
        if (!provider) {
          continue
        }
        gitWorktrees = await provider.listWorktrees(repo.path)
      } else {
        gitWorktrees = await listRepoWorktrees(repo)
      }
      for (const gw of gitWorktrees) {
        const worktreeId = `${repo.id}::${gw.path}`
        const meta = store.getWorktreeMeta(worktreeId)
        allWorktrees.push(mergeWorktree(repo.id, gw, meta, repo.displayName))
      }
    }

    return allWorktrees
  })

  ipcMain.handle('worktrees:list', async (_event, args: { repoId: string }) => {
    // Why: use ensureAuthorizedRootsCache (not rebuild) to avoid redundantly
    // listing git worktrees when the cache is already fresh — the handler
    // itself calls listWorktrees below.
    await ensureAuthorizedRootsCache(store)
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      return []
    }

    let gitWorktrees
    if (isFolderRepo(repo)) {
      gitWorktrees = [createFolderWorktree(repo)]
    } else if (repo.connectionId) {
      const provider = getSshGitProvider(repo.connectionId)
      // Why: when SSH is disconnected the provider is null. Throwing here
      // makes the renderer's fetchWorktrees catch block preserve its cached
      // worktree list instead of replacing it with an empty array.
      if (!provider) {
        throw new Error(`SSH connection "${repo.connectionId}" is not active`)
      }
      gitWorktrees = await provider.listWorktrees(repo.path)
    } else {
      gitWorktrees = await listRepoWorktrees(repo)
    }
    return gitWorktrees.map((gw) => {
      const worktreeId = `${repo.id}::${gw.path}`
      const meta = store.getWorktreeMeta(worktreeId)
      return mergeWorktree(repo.id, gw, meta, repo.displayName)
    })
  })

  ipcMain.handle(
    'worktrees:create',
    async (_event, args: CreateWorktreeArgs): Promise<CreateWorktreeResult> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${args.repoId}`)
      }
      if (isFolderRepo(repo)) {
        throw new Error('Folder mode does not support creating worktrees.')
      }

      // Remote repos route all git operations through the relay
      if (repo.connectionId) {
        return createRemoteWorktree(args, repo, store, mainWindow)
      }

      return createLocalWorktree(args, repo, store, mainWindow)
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
      if (isFolderRepo(repo)) {
        throw new Error('Folder mode does not support deleting worktrees.')
      }

      if (repo.connectionId) {
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${repo.connectionId}"`)
        }
        await provider.removeWorktree(worktreePath, args.force)
        store.removeWorktreeMeta(args.worktreeId)
        deleteWorktreeHistoryDir(args.worktreeId)
        notifyWorktreesChanged(mainWindow, repoId)
        return
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
          // Why: `git worktree remove` failed, so git's internal worktree tracking
          // (`.git/worktrees/<name>`) is still intact. Without pruning, `git worktree
          // list` continues to show the stale entry and the branch it had checked out
          // remains locked — other worktrees cannot check it out.
          await gitExecFileAsync(['worktree', 'prune'], { cwd: repo.path }).catch(() => {})
          store.removeWorktreeMeta(args.worktreeId)
          deleteWorktreeHistoryDir(args.worktreeId)
          await rebuildAuthorizedRootsCache(store)
          notifyWorktreesChanged(mainWindow, repoId)
          return
        }
        throw new Error(formatWorktreeRemovalError(error, worktreePath, args.force ?? false))
      }
      store.removeWorktreeMeta(args.worktreeId)
      deleteWorktreeHistoryDir(args.worktreeId)
      await rebuildAuthorizedRootsCache(store)

      notifyWorktreesChanged(mainWindow, repoId)
    }
  )

  ipcMain.handle(
    'worktrees:updateMeta',
    (_event, args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => {
      const meta = store.setWorktreeMeta(args.worktreeId, args.updates)
      // Do NOT call notifyWorktreesChanged here. The renderer applies meta
      // updates optimistically before calling this IPC, so a notification
      // would trigger a redundant fetchWorktrees round-trip that bumps
      // sortEpoch and reorders the sidebar — the exact bug PR #209 tried
      // to fix (clicking a card would clear isUnread → updateMeta →
      // worktrees:changed → fetchWorktrees → sortEpoch++ → re-sort).
      return meta
    }
  )

  // Why: the renderer continuously snapshots the computed sidebar order into
  // sortOrder so that it can be restored on cold start (when ephemeral signals
  // like running jobs and live terminals are gone). A single batch call avoids
  // N individual updateMeta IPC round-trips; the persistence layer debounces
  // the actual disk write.
  ipcMain.handle('worktrees:persistSortOrder', (_event, args: { orderedIds: string[] }) => {
    // Defensive: guard against malformed or missing input from the renderer.
    if (!Array.isArray(args?.orderedIds) || args.orderedIds.length === 0) {
      return
    }
    const now = Date.now()
    for (let i = 0; i < args.orderedIds.length; i++) {
      // Descending timestamps so that the first item has the highest
      // sortOrder value (most recent), making b.sortOrder - a.sortOrder
      // a natural "first wins" comparator on cold start.
      store.setWorktreeMeta(args.orderedIds[i], { sortOrder: now - i * 1000 })
    }
  })

  ipcMain.handle('hooks:check', (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return { hasHooks: false, hooks: null, mayNeedUpdate: false }
    }

    const has = hasHooksFile(repo.path)
    const hooks = has ? loadHooks(repo.path) : null
    // Why: when a newer Orca version adds a top-level key to `orca.yaml`, older
    // versions that don't recognise it return null and show "could not be parsed".
    // Detecting well-formed but unrecognised keys lets the UI suggest updating
    // instead of implying the file is broken.
    const mayNeedUpdate = has && !hooks && hasUnrecognizedOrcaYamlKeys(repo.path)
    return {
      hasHooks: has,
      hooks,
      mayNeedUpdate
    }
  })

  ipcMain.handle(
    'hooks:createIssueCommandRunner',
    (_event, args: { repoId: string; worktreePath: string; command: string }) => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${args.repoId}`)
      }

      return createIssueCommandRunnerScript(repo, args.worktreePath, args.command)
    }
  )

  ipcMain.handle('hooks:readIssueCommand', (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return {
        localContent: null,
        sharedContent: null,
        effectiveContent: null,
        localFilePath: '',
        source: 'none' as const
      }
    }
    return readIssueCommand(repo.path)
  })

  ipcMain.handle('hooks:writeIssueCommand', (_event, args: { repoId: string; content: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return
    }
    writeIssueCommand(repo.path, args.content)
  })
}
