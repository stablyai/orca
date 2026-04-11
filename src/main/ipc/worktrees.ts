import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { rm } from 'fs/promises'
import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  Worktree,
  WorktreeMeta
} from '../../shared/types'
import { getPRForBranch } from '../github/client'
import {
  listWorktrees,
  addWorktree,
  removeWorktree,
  removeWorktreeAdminEntry
} from '../git/worktree'
import { getGitUsername, getDefaultBaseRef, getBranchConflictKind } from '../git/repo'
import { gitExecFileSync } from '../git/runner'
import { isWslPath, parseWslPath, getWslHome } from '../wsl'
import { join } from 'path'
import { listRepoWorktrees } from '../repo-worktrees'
import {
  createSetupRunnerScript,
  getEffectiveHooks,
  loadHooks,
  readIssueCommand,
  runHook,
  hasHooksFile,
  hasUnrecognizedOrcaYamlKeys,
  shouldRunSetupForCreate,
  writeIssueCommand
} from '../hooks'
import {
  sanitizeWorktreeName,
  computeBranchName,
  computeWorktreePath,
  ensurePathWithinWorkspace,
  shouldSetDisplayName,
  mergeWorktree,
  parseWorktreeId,
  areWorktreePathsEqual,
  formatWorktreeRemovalError,
  isOrphanedWorktreeError
} from './worktree-logic'
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
      const gitWorktrees = await listRepoWorktrees(repo)
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

    const gitWorktrees = await listRepoWorktrees(repo)
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

      const settings = store.getSettings()

      const requestedName = args.name
      const sanitizedName = sanitizeWorktreeName(args.name)

      // Compute branch name with prefix
      const username = getGitUsername(repo.path)
      const branchName = computeBranchName(sanitizedName, settings, username)

      const branchConflictKind = await getBranchConflictKind(repo.path, branchName)
      if (branchConflictKind) {
        throw new Error(
          `Branch "${branchName}" already exists ${branchConflictKind === 'local' ? 'locally' : 'on a remote'}. Pick a different worktree name.`
        )
      }

      // Why: the UI resolves PR status by branch name alone. Reusing a historical
      // PR head name would make a fresh worktree inherit that old merged/closed PR
      // immediately, so we reject the name instead of silently suffixing it.
      // The lookup is best-effort — don't block creation if GitHub is unreachable.
      let existingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
      try {
        existingPR = await getPRForBranch(repo.path, branchName)
      } catch {
        // GitHub API may be unreachable, rate-limited, or token missing
      }
      if (existingPR) {
        throw new Error(
          `Branch "${branchName}" already has PR #${existingPR.number}. Pick a different worktree name.`
        )
      }

      // Compute worktree path
      let worktreePath = computeWorktreePath(sanitizedName, repo.path, settings)
      // Why: WSL worktrees live under ~/orca/workspaces inside the WSL
      // filesystem. Validate against that root, not the Windows workspace dir.
      // If WSL home lookup fails, keep using the configured workspace root so
      // the path traversal guard still runs on the fallback path.
      const wslInfo = isWslPath(repo.path) ? parseWslPath(repo.path) : null
      const wslHome = wslInfo ? getWslHome(wslInfo.distro) : null
      const workspaceRoot = wslHome ? join(wslHome, 'orca', 'workspaces') : settings.workspaceDir
      worktreePath = ensurePathWithinWorkspace(worktreePath, workspaceRoot)

      // Determine base branch
      const baseBranch = args.baseBranch || repo.worktreeBaseRef || getDefaultBaseRef(repo.path)
      const setupScript = getEffectiveHooks(repo)?.scripts.setup
      // Why: `ask` is a pre-create choice gate, not a post-create side effect.
      // Resolve it before mutating git state so missing UI input cannot strand
      // a real worktree on disk while the renderer reports "create failed".
      const shouldLaunchSetup = setupScript
        ? shouldRunSetupForCreate(repo, args.setupDecision)
        : false

      // Fetch latest from remote so the worktree starts with up-to-date content
      const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
      try {
        gitExecFileSync(['fetch', remote], { cwd: repo.path })
      } catch {
        // Fetch is best-effort — don't block worktree creation if offline
      }

      addWorktree(
        repo.path,
        worktreePath,
        branchName,
        baseBranch,
        settings.refreshLocalBaseRefOnWorktreeCreate
      )

      // Re-list to get the freshly created worktree info
      const gitWorktrees = await listWorktrees(repo.path)
      const created = gitWorktrees.find((gw) => areWorktreePathsEqual(gw.path, worktreePath))
      if (!created) {
        throw new Error('Worktree created but not found in listing')
      }

      const worktreeId = `${repo.id}::${created.path}`
      const metaUpdates: Partial<WorktreeMeta> = {
        // Stamp activity so the worktree sorts into its final position
        // immediately — prevents scroll-to-reveal racing with a later
        // bumpWorktreeActivity that would re-sort the list.
        lastActivityAt: Date.now(),
        ...(shouldSetDisplayName(requestedName, branchName, sanitizedName)
          ? { displayName: requestedName }
          : {})
      }
      const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
      const worktree = mergeWorktree(repo.id, created, meta)
      await rebuildAuthorizedRootsCache(store)

      let setup: CreateWorktreeResult['setup']
      if (setupScript && shouldLaunchSetup) {
        try {
          // Why: setup now runs in a visible terminal owned by the renderer so users
          // can inspect failures, answer prompts, and rerun it. The main process only
          // resolves policy and writes the runner script; it must not execute setup
          // itself anymore or we would reintroduce the hidden background-hook behavior.
          //
          // Why: the git worktree already exists at this point. If runner generation
          // fails, surfacing the error as a hard create failure would lie to the UI
          // about the underlying git state and strand a real worktree on disk.
          // Degrade to "created without setup launch" instead.
          setup = createSetupRunnerScript(repo, worktreePath, setupScript)
        } catch (error) {
          console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
        }
      }

      notifyWorktreesChanged(mainWindow, repo.id)
      return {
        worktree,
        ...(setup ? { setup } : {})
      }
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
          // Why: targeted removal only cleans up the specific admin entry for this
          // worktree. A blanket `git worktree prune` would destroy admin entries for
          // ALL worktrees whose .git files are missing — cascading damage to sibling
          // nested worktrees that are temporarily inaccessible.
          await removeWorktreeAdminEntry(repo.path, worktreePath).catch(() => {})
          store.removeWorktreeMeta(args.worktreeId)
          await rebuildAuthorizedRootsCache(store)
          notifyWorktreesChanged(mainWindow, repoId)
          return
        }
        throw new Error(formatWorktreeRemovalError(error, worktreePath, args.force ?? false))
      }
      store.removeWorktreeMeta(args.worktreeId)
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

function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:changed', { repoId })
  }
}
