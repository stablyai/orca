/* oxlint-disable max-lines */
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { rm } from 'fs/promises'
import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import { deleteWorktreeHistoryDir } from '../terminal-history'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  GitWorktreeInfo,
  Repo,
  WorktreeMeta
} from '../../shared/types'
import { removeWorktree } from '../git/worktree'
import { gitExecFileAsync } from '../git/runner'
import { getDefaultRemote } from '../git/repo'
import { getWorkItem } from '../github/client'
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
import { invalidateAuthorizedRootsCache, registerWorktreeRootsForRepo } from './filesystem-auth'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { killAllProcessesForWorktree } from '../runtime/worktree-teardown'
import { getLocalPtyProvider } from './pty'
import { removeWorktreeSymlinks } from './worktree-symlinks'
import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { workspaceSourceSchema, type WorkspaceSource } from '../../shared/telemetry-events'
import { classifyWorkspaceCreateError } from './workspace-create-error-classifier'

// Why: worktrees discovered on disk (not created via Orca's UI) have no
// persisted WorktreeMeta, so mergeWorktree falls back to `lastActivityAt: 0`.
// That makes them sort to the bottom of "Recent" even though the user just
// added the repo / folder. Stamp discovery time the first time we see a
// worktree so its very existence counts as a recency signal. Subsequent
// list calls find the persisted meta and skip the stamp.
function resolveWorktreeMetaWithDiscoveryStamp(store: Store, worktreeId: string): WorktreeMeta {
  const existing = store.getWorktreeMeta(worktreeId)
  if (existing) {
    return existing
  }
  return store.setWorktreeMeta(worktreeId, { lastActivityAt: Date.now() })
}

const loggedUnavailableSshGitProviders = new Set<string>()
const loggedWorktreeListFailures = new Set<string>()

function warnOnce(keySet: Set<string>, key: string, message: string, error?: unknown): void {
  if (keySet.has(key)) {
    return
  }
  keySet.add(key)
  if (error) {
    console.warn(message, error)
  } else {
    console.warn(message)
  }
}

function rememberLocalWorktreeRoots(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): void {
  if (repo.connectionId) {
    return
  }
  // Why: worktrees:list already paid the `git worktree list` cost. Reusing
  // that result keeps later git/file IPC validation from doing a second
  // background scan that can trigger macOS folder-permission prompts.
  registerWorktreeRootsForRepo(store, repo.id, [
    repo.path,
    ...gitWorktrees.map((worktree) => worktree.path)
  ])
}

export function registerWorktreeHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('worktrees:listAll')
  ipcMain.removeHandler('worktrees:list')
  ipcMain.removeHandler('worktrees:create')
  ipcMain.removeHandler('worktrees:resolvePrBase')
  ipcMain.removeHandler('worktrees:remove')
  ipcMain.removeHandler('worktrees:updateMeta')
  ipcMain.removeHandler('worktrees:persistSortOrder')
  ipcMain.removeHandler('hooks:check')
  ipcMain.removeHandler('hooks:createIssueCommandRunner')
  ipcMain.removeHandler('hooks:readIssueCommand')
  ipcMain.removeHandler('hooks:writeIssueCommand')

  ipcMain.handle('worktrees:listAll', async () => {
    const repos = store.getRepos()

    // Why: repos are listed in parallel so total time = slowest repo, not
    // the sum of all repos. Each listRepoWorktrees spawns `git worktree list`.
    const results = await Promise.all(
      repos.map(async (repo) => {
        try {
          let gitWorktrees
          if (isFolderRepo(repo)) {
            gitWorktrees = [createFolderWorktree(repo)]
          } else if (repo.connectionId) {
            const provider = getSshGitProvider(repo.connectionId)
            if (!provider) {
              warnOnce(
                loggedUnavailableSshGitProviders,
                `${repo.connectionId}:${repo.id}`,
                `[worktrees] SSH git provider unavailable; skipping worktree list for repo "${repo.displayName}" (${repo.id}) at ${repo.path} on connection ${repo.connectionId}`
              )
              return []
            }
            loggedUnavailableSshGitProviders.delete(`${repo.connectionId}:${repo.id}`)
            gitWorktrees = await provider.listWorktrees(repo.path)
          } else {
            gitWorktrees = await listRepoWorktrees(repo)
          }
          rememberLocalWorktreeRoots(store, repo, gitWorktrees)
          loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
          return gitWorktrees.map((gw) => {
            const worktreeId = `${repo.id}::${gw.path}`
            const meta = resolveWorktreeMetaWithDiscoveryStamp(store, worktreeId)
            return mergeWorktree(repo.id, gw, meta, repo.displayName)
          })
        } catch (err) {
          warnOnce(
            loggedWorktreeListFailures,
            `${repo.id}:${repo.path}`,
            `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
            err
          )
          // Why: do NOT seed an empty success here. registerWorktreeRootsForRepo
          // would mark this repo as registered and flip
          // registeredWorktreeRootsDirty to false, which causes
          // resolveRegisteredWorktreePath to permanently deny access to
          // legitimate linked worktrees of this repo until something invalidates
          // the cache. Leaving it unregistered keeps the cache dirty so the
          // next access path can rebuild.
          return []
        }
      })
    )

    return results.flat()
  })

  ipcMain.handle('worktrees:list', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      return []
    }

    try {
      let gitWorktrees
      if (isFolderRepo(repo)) {
        gitWorktrees = [createFolderWorktree(repo)]
      } else if (repo.connectionId) {
        const provider = getSshGitProvider(repo.connectionId)
        // Why: when SSH is disconnected the provider is null. Return [] so the
        // renderer's fetchWorktrees guard (`worktrees.length === 0 && current.length > 0`)
        // preserves its cached worktree list. This avoids a console error on every
        // fetchAllWorktrees cycle while the connection is being (re-)established —
        // worktrees will be properly populated when the SSH `connected` event fires
        // and triggers a re-fetch.
        if (!provider) {
          warnOnce(
            loggedUnavailableSshGitProviders,
            `${repo.connectionId}:${repo.id}`,
            `[worktrees] SSH git provider unavailable; skipping worktree list for repo "${repo.displayName}" (${repo.id}) at ${repo.path} on connection ${repo.connectionId}`
          )
          return []
        }
        loggedUnavailableSshGitProviders.delete(`${repo.connectionId}:${repo.id}`)
        gitWorktrees = await provider.listWorktrees(repo.path)
      } else {
        gitWorktrees = await listRepoWorktrees(repo)
      }
      rememberLocalWorktreeRoots(store, repo, gitWorktrees)
      loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
      return gitWorktrees.map((gw) => {
        const worktreeId = `${repo.id}::${gw.path}`
        const meta = resolveWorktreeMetaWithDiscoveryStamp(store, worktreeId)
        return mergeWorktree(repo.id, gw, meta, repo.displayName)
      })
    } catch (err) {
      warnOnce(
        loggedWorktreeListFailures,
        `${repo.id}:${repo.path}`,
        `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
        err
      )
      // Why: see worktrees:listAll catch — seeding an empty-success result
      // would poison the auth cache and block linked worktrees.
      return []
    }
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

      const sourceParse = workspaceSourceSchema.safeParse(args.telemetrySource)
      const source: WorkspaceSource = sourceParse.success ? sourceParse.data : 'unknown'

      let result: CreateWorktreeResult
      try {
        // Why: only wrap the helpers themselves. The pre-validation throws
        // above (`Repo not found`, `Folder mode does not support creating
        // worktrees`) signal IPC-shape bugs, not the user-visible
        // git/filesystem failures the funnel cares about — bucketing them
        // into `unknown` would pollute the failure taxonomy.
        result = repo.connectionId
          ? await createRemoteWorktree(args, repo, store, mainWindow)
          : await createLocalWorktree(args, repo, store, mainWindow, runtime)
      } catch (error) {
        track('workspace_create_failed', {
          source,
          error_class: classifyWorkspaceCreateError(error),
          ...getCohortAtEmit()
        })
        throw error
      }

      // Why: emit `workspace_created` only after the underlying create has
      // resolved (the helpers throw on failure, so reaching this line means
      // git-add succeeded — we deliberately do not also emit a separate
      // `workspace_initialized`, see telemetry-plan.md§Deferred events).
      // `from_existing_branch` is true iff the caller specified a non-empty
      // baseBranch; an unspecified baseBranch means "branch from default
      // HEAD", which is the not-from-existing-branch case. We never send
      // the branch name itself.
      track('workspace_created', {
        source,
        from_existing_branch: typeof args.baseBranch === 'string' && args.baseBranch.length > 0,
        ...getCohortAtEmit()
      })

      return result
    }
  )

  ipcMain.handle(
    'worktrees:resolvePrBase',
    async (
      _event,
      args: {
        repoId: string
        prNumber: number
        headRefName?: string
        isCrossRepository?: boolean
      }
    ): Promise<{ baseBranch: string } | { error: string }> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return { error: 'Repo not found' }
      }
      // Why: remote SSH repos are out of scope in v1. The picker already
      // disables its PR tab for them — this guard belt-and-suspenders it.
      if (repo.connectionId) {
        return { error: 'PR start points are not supported for remote repos yet.' }
      }
      if (isFolderRepo(repo)) {
        return { error: 'Folder mode does not support creating worktrees.' }
      }

      let headRefName = args.headRefName?.trim() ?? ''
      let isCrossRepository = args.isCrossRepository === true

      // Skip the gh lookup when both hints are present (picker already has them).
      if (!headRefName) {
        // Why: the caller already knows this is a PR number, so scope the
        // lookup to `type: 'pr'` and skip the speculative issue-first probe
        // that would hit the upstream issue tracker for fork checkouts.
        const item = await getWorkItem(repo.path, args.prNumber, 'pr')
        if (!item || item.type !== 'pr') {
          return { error: `PR #${args.prNumber} not found.` }
        }
        headRefName = (item.branchName ?? '').trim()
        if (!headRefName) {
          return { error: `PR #${args.prNumber} has no head branch.` }
        }
        if (item.isCrossRepository === true) {
          isCrossRepository = true
        }
      }

      let remote: string
      try {
        remote = await getDefaultRemote(repo.path)
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
      }

      // Why: fork PR heads live on a remote we don't have configured, so
      // `git fetch <remote> <headRefName>` would fail. GitHub exposes every
      // PR head (fork or same-repo) as refs/pull/<N>/head on the upstream
      // repo. Fetch that and snapshot the SHA — the new worktree branch is
      // derived from the workspace name, so there's no tracking ref to set
      // up, which makes SHA semantics ("branch from this commit") cleaner
      // than returning a ref that would go stale on force-push.
      if (isCrossRepository) {
        const pullRef = `refs/pull/${args.prNumber}/head`
        try {
          await gitExecFileAsync(['fetch', remote, pullRef], { cwd: repo.path })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {
            error: `Failed to fetch ${pullRef}: ${message.split('\n')[0]}`
          }
        }
        let sha: string
        try {
          const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', 'FETCH_HEAD'], {
            cwd: repo.path
          })
          sha = stdout.trim()
        } catch {
          return { error: `Could not resolve fork PR #${args.prNumber} head after fetch.` }
        }
        if (!sha) {
          return { error: `Empty SHA resolving fork PR #${args.prNumber} head.` }
        }
        return { baseBranch: sha }
      }

      try {
        await gitExecFileAsync(['fetch', remote, headRefName], { cwd: repo.path })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          error: `Failed to fetch ${remote}/${headRefName}: ${message.split('\n')[0]}`
        }
      }

      const remoteRef = `${remote}/${headRefName}`
      try {
        await gitExecFileAsync(['rev-parse', '--verify', remoteRef], { cwd: repo.path })
      } catch {
        return { error: `Remote ref ${remoteRef} does not exist after fetch.` }
      }

      return { baseBranch: remoteRef }
    }
  )

  ipcMain.handle(
    'worktrees:remove',
    async (_event, args: { worktreeId: string; force?: boolean; skipArchive?: boolean }) => {
      const { repoId, worktreePath } = parseWorktreeId(args.worktreeId)
      const repo = store.getRepo(repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${repoId}`)
      }
      if (isFolderRepo(repo)) {
        throw new Error('Folder mode does not support deleting worktrees.')
      }

      // Why: kill every PTY belonging to this worktree BEFORE git-level
      // removal. The renderer pre-kills via shutdownWorktreeTerminals, but
      // defensive teardown here protects against: (a) a future renderer bug,
      // (b) a disconnected window, (c) an out-of-band window.api.worktrees.remove
      // caller. Placement is before the SSH early-return so local-host PTYs
      // are still reaped for local repos; SSH-backed PTYs are handled by the
      // remote provider's own teardown (design §4.3, §6).
      if (!repo.connectionId) {
        await killAllProcessesForWorktree(args.worktreeId, {
          runtime,
          localProvider: getLocalPtyProvider()
        })
          .then((r) => {
            const total = r.runtimeStopped + r.providerStopped + r.registryStopped
            if (total > 0) {
              console.info(
                `[worktree-teardown] ${args.worktreeId} killed runtime=${r.runtimeStopped} provider=${r.providerStopped} registry=${r.registryStopped}`
              )
            }
          })
          .catch((err) => {
            console.warn(`[worktree-teardown] failed for ${args.worktreeId}:`, err)
          })
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
      if (hooks?.scripts.archive && !args.skipArchive) {
        const result = await runHook('archive', worktreePath, repo)
        if (!result.success) {
          console.error(`[hooks] archive hook failed for ${worktreePath}:`, result.output)
        }
      }

      // Why: `git worktree remove` (non-force) refuses to delete a worktree
      // that has untracked files, and a symlink pointing into the primary
      // checkout looks untracked to git. Unlink the user-configured symlinks
      // first so the normal delete path keeps working — otherwise every
      // deletion would require the Force Delete toast once the feature is on.
      if (repo.symlinkPaths && repo.symlinkPaths.length > 0) {
        await removeWorktreeSymlinks(worktreePath, repo.symlinkPaths)
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
          invalidateAuthorizedRootsCache()
          notifyWorktreesChanged(mainWindow, repoId)
          return
        }
        throw new Error(formatWorktreeRemovalError(error, worktreePath, args.force ?? false))
      }
      store.removeWorktreeMeta(args.worktreeId)
      deleteWorktreeHistoryDir(args.worktreeId)
      invalidateAuthorizedRootsCache()

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
