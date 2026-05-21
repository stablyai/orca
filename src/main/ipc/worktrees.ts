/* oxlint-disable max-lines */
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { readFile, rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import { inspectSetupScriptImportCandidates } from '../../shared/setup-script-imports'
import { deleteWorktreeHistoryDir } from '../terminal-history'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  GitPushTarget,
  GitWorktreeInfo,
  Repo,
  WorktreeMeta
} from '../../shared/types'
import {
  assertWorktreeCleanForRemoval,
  listWorktrees as listGitWorktrees,
  removeWorktree
} from '../git/worktree'
import { gitExecFileAsync } from '../git/runner'
import { withWorktreeSpan } from '../observability/instrumentation'
import { getDefaultRemote } from '../git/repo'
import { resolveGitHubPrStartPoint } from '../github/pr-start-point'
import { getProjectRef as getGlabProjectRef, getGlabKnownHosts } from '../gitlab/gl-utils'
import { getWorkItemByProjectRef as getGitLabWorkItemByProjectRef } from '../gitlab/client'
import { listRepoWorktrees, createFolderWorktree } from '../repo-worktrees'
import { getSshGitProvider, requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  createIssueCommandRunnerScript,
  getEffectiveHooks,
  loadHooks,
  parseOrcaYaml,
  readIssueCommand,
  runHook,
  hasHooksFile,
  hasUnrecognizedOrcaYamlKeys,
  writeIssueCommand
} from '../hooks'
import {
  mergeWorktree,
  parseWorktreeId,
  areWorktreePathsEqual,
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError,
  isOrphanedWorktreeError
} from './worktree-logic'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import {
  createLocalWorktree,
  createRemoteWorktree,
  cleanupUnusedWorktreePushTargetRemote,
  cleanupUnusedWorktreePushTargetRemoteSsh,
  notifyWorktreesChanged
} from './worktree-remote'
import {
  invalidateAuthorizedRootsCache,
  isENOENT,
  registerWorktreeRootsForRepo
} from './filesystem-auth'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { killAllProcessesForWorktree } from '../runtime/worktree-teardown'
import { getLocalPtyProvider } from './pty'
import { removeWorktreeSymlinks } from './worktree-symlinks'
import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { workspaceSourceSchema, type WorkspaceSource } from '../../shared/telemetry-events'
import { classifyWorkspaceCreateError } from './workspace-create-error-classifier'
import {
  canSafelyRemoveOrphanedWorktreeDirectory,
  getRegisteredDeletableWorktree
} from '../worktree-removal-safety'

// Why: worktrees discovered on disk (not created via Orca's UI) have no
// persisted WorktreeMeta, so mergeWorktree falls back to `lastActivityAt: 0`.
// That makes them sort to the bottom of "Recent" even though the user just
// added the repo / folder. Stamp discovery time the first time we see a
// worktree so its very existence counts as a recency signal. Subsequent
// list calls find the persisted meta and skip the stamp.
function resolveWorktreeMetaWithDiscoveryStamp(store: Store, worktreeId: string): WorktreeMeta {
  const existing = store.getWorktreeMeta(worktreeId)
  if (existing) {
    if (!existing.instanceId) {
      // Why: profiles created before lineage shipped already have WorktreeMeta
      // rows. Backfill on authoritative discovery so upgraded workspaces can
      // immediately participate in instance-validated lineage.
      return store.setWorktreeMeta(worktreeId, { instanceId: randomUUID() })
    }
    return existing
  }
  return store.setWorktreeMeta(worktreeId, { lastActivityAt: Date.now() })
}

const loggedUnavailableSshGitProviders = new Set<string>()
const loggedWorktreeListFailures = new Set<string>()
const loggedMalformedWorktreeMetaKeys = new Set<string>()

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

function pruneLineageForMissingRepoWorktrees(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): void {
  if (
    typeof store.getAllWorktreeLineage !== 'function' ||
    typeof store.removeWorktreeLineage !== 'function'
  ) {
    return
  }
  const liveIds = new Set(gitWorktrees.map((worktree) => `${repo.id}::${worktree.path}`))
  const repoPrefix = `${repo.id}::`
  for (const [childId, lineage] of Object.entries(store.getAllWorktreeLineage())) {
    if (childId.startsWith(repoPrefix) && !liveIds.has(childId)) {
      // Why: path-derived IDs can disappear and later be reused by a different
      // checkout. Once a successful scan proves the child is gone, drop its
      // lineage so a future same-path worktree cannot inherit it. Missing
      // parents stay readable so the UI can show the repairable "Missing
      // parent" state.
      store.removeWorktreeLineage(childId)
    }
    if (lineage.parentWorktreeId.startsWith(repoPrefix) && !liveIds.has(lineage.parentWorktreeId)) {
      const parentMeta = store.getWorktreeMeta(lineage.parentWorktreeId)
      if (!parentMeta || parentMeta.instanceId === lineage.parentWorktreeInstanceId) {
        // Why: keep the child lineage so the UI can show "Missing parent", but
        // rotate the absent parent's stale identity once. If a different
        // checkout later reuses that path, the old lineage stays invalid.
        store.setWorktreeMeta(lineage.parentWorktreeId, { instanceId: randomUUID() })
      }
    }
  }
}

type SshWorktreeMetaCandidate = {
  path: string
  meta: WorktreeMeta
}

type SshWorktreeMetaIndex = Map<string, SshWorktreeMetaCandidate[]>

function createSshWorktreeMetaIndex(entries: [string, WorktreeMeta][]): SshWorktreeMetaIndex {
  const index: SshWorktreeMetaIndex = new Map()
  for (const [worktreeId, meta] of entries) {
    let parsed: { repoId: string; worktreePath: string }
    try {
      parsed = parseWorktreeId(worktreeId)
    } catch (err) {
      warnOnce(
        loggedMalformedWorktreeMetaKeys,
        worktreeId,
        `[worktrees] ignoring malformed persisted worktree metadata key "${worktreeId}"`,
        err
      )
      continue
    }

    const candidates = index.get(parsed.repoId) ?? []
    candidates.push({ path: parsed.worktreePath, meta })
    index.set(parsed.repoId, candidates)
  }
  return index
}

function synthesizeSshGitWorktree(repo: Repo, path: string, meta: WorktreeMeta): GitWorktreeInfo {
  return {
    path,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: areWorktreePathsEqual(path, repo.path),
    ...(meta.sparseDirectories !== undefined ||
    meta.sparseBaseRef !== undefined ||
    meta.sparsePresetId !== undefined
      ? { isSparse: true }
      : {})
  }
}

function listDisconnectedSshWorktrees(
  repo: Repo,
  metaIndex: SshWorktreeMetaIndex
): ReturnType<typeof mergeWorktree>[] {
  const byWorktreeId = new Map<string, ReturnType<typeof mergeWorktree>>()
  for (const candidate of metaIndex.get(repo.id) ?? []) {
    const worktree = mergeWorktree(
      repo.id,
      synthesizeSshGitWorktree(repo, candidate.path, candidate.meta),
      candidate.meta
    )
    byWorktreeId.delete(worktree.id)
    byWorktreeId.set(worktree.id, worktree)
  }
  return [...byWorktreeId.values()]
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
  ipcMain.removeHandler('worktrees:listLineage')
  ipcMain.removeHandler('worktrees:updateLineage')
  ipcMain.removeHandler('worktrees:persistSortOrder')
  ipcMain.removeHandler('hooks:check')
  ipcMain.removeHandler('hooks:inspectSetupScriptImports')
  ipcMain.removeHandler('hooks:createIssueCommandRunner')
  ipcMain.removeHandler('hooks:readIssueCommand')
  ipcMain.removeHandler('hooks:writeIssueCommand')

  ipcMain.handle('worktrees:listAll', async () => {
    const repos = store.getRepos()
    const sshWorktreeMetaIndex = repos.some((repo) => repo.connectionId)
      ? createSshWorktreeMetaIndex(Object.entries(store.getAllWorktreeMeta()))
      : new Map()

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
              return listDisconnectedSshWorktrees(repo, sshWorktreeMetaIndex)
            }
            loggedUnavailableSshGitProviders.delete(`${repo.connectionId}:${repo.id}`)
            try {
              gitWorktrees = await provider.listWorktrees(repo.path)
            } catch (err) {
              warnOnce(
                loggedWorktreeListFailures,
                `${repo.id}:${repo.path}`,
                `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
                err
              )
              return listDisconnectedSshWorktrees(repo, sshWorktreeMetaIndex)
            }
          } else {
            gitWorktrees = await listRepoWorktrees(repo)
          }
          rememberLocalWorktreeRoots(store, repo, gitWorktrees)
          pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
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
    const sshWorktreeMetaIndex = repo.connectionId
      ? createSshWorktreeMetaIndex(Object.entries(store.getAllWorktreeMeta()))
      : new Map()

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
          return listDisconnectedSshWorktrees(repo, sshWorktreeMetaIndex)
        }
        loggedUnavailableSshGitProviders.delete(`${repo.connectionId}:${repo.id}`)
        try {
          gitWorktrees = await provider.listWorktrees(repo.path)
        } catch (err) {
          warnOnce(
            loggedWorktreeListFailures,
            `${repo.id}:${repo.path}`,
            `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
            err
          )
          return listDisconnectedSshWorktrees(repo, sshWorktreeMetaIndex)
        }
      } else {
        gitWorktrees = await listRepoWorktrees(repo)
      }
      rememberLocalWorktreeRoots(store, repo, gitWorktrees)
      pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
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
      // Why span here: worktree creation chains a clone-or-checkout, an
      // install hook, and several git invocations. Wrapping the IPC entry
      // gives every child git span a parent to attach to, so a failure in
      // step 3 of 5 still shows up in the trace tree alongside steps 1–2.
      // The branch name and remote URL are intentionally not added as
      // attributes — branch names can carry user-content (e.g. an issue
      // title) and the redactor would have to learn yet another rule;
      // the repo ID is the safer correlator for the bundle.
      return withWorktreeSpan({ stage: 'create' }, async () => {
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
      })
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
    ): Promise<{ baseBranch: string; pushTarget?: GitPushTarget } | { error: string }> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return { error: 'Repo not found' }
      }
      if (isFolderRepo(repo)) {
        return { error: 'Folder mode does not support creating worktrees.' }
      }
      const gitExec = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
        if (!repo.connectionId) {
          return gitExecFileAsync(args, { cwd: repo.path })
        }
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          throw new Error(
            'SSH Git provider is not available. Reconnect to this target and try again.'
          )
        }
        return provider.exec(args, repo.path)
      }

      return resolveGitHubPrStartPoint({
        repoPath: repo.path,
        prNumber: args.prNumber,
        headRefName: args.headRefName,
        isCrossRepository: args.isCrossRepository,
        connectionId: repo.connectionId ?? null,
        gitExec,
        resolveRemote: async () => {
          if (repo.connectionId) {
            const { stdout } = await gitExec(['remote'])
            return (
              stdout
                .split('\n')
                .map((line) => line.trim())
                .find(Boolean) ?? 'origin'
            )
          }
          return getDefaultRemote(repo.path)
        }
      })
    }
  )

  // Why: GitLab parallel of worktrees:resolvePrBase. Same shape, same
  // semantics — caller passes mrIid (with optional source_branch +
  // isCrossRepository hints from the picker) and we return either a
  // `<remote>/<source_branch>` ref (same-project MRs) or a SHA fetched
  // from refs/merge-requests/<iid>/head (fork MRs). The returned value
  // is the workspace's base ref; the new worktree branch derives from
  // the workspace name, not from the source ref.
  ipcMain.handle(
    'worktrees:resolveMrBase',
    async (
      _event,
      args: {
        repoId: string
        mrIid: number
        sourceBranch?: string
        isCrossRepository?: boolean
      }
    ): Promise<{ baseBranch: string } | { error: string }> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return { error: 'Repo not found' }
      }
      // Why: parity with the gh-side guard above. Remote SSH repos are
      // out of v1 scope; the picker disables the GitLab tab for them too.
      if (repo.connectionId) {
        return { error: 'MR start points are not supported for remote repos yet.' }
      }
      if (isFolderRepo(repo)) {
        return { error: 'Folder mode does not support creating worktrees.' }
      }

      let sourceBranch = args.sourceBranch?.trim() ?? ''
      let isCrossRepository = args.isCrossRepository === true

      if (!sourceBranch) {
        const knownHosts = await getGlabKnownHosts()
        const projectRef = await getGlabProjectRef(repo.path, knownHosts)
        if (!projectRef) {
          return { error: 'No GitLab project found for this repository.' }
        }
        const item = await getGitLabWorkItemByProjectRef(repo.path, projectRef, args.mrIid, 'mr')
        if (!item || item.type !== 'mr') {
          return { error: `MR !${args.mrIid} not found.` }
        }
        sourceBranch = (item.branchName ?? '').trim()
        if (!sourceBranch) {
          return { error: `MR !${args.mrIid} has no source branch.` }
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

      // Why: GitLab exposes every MR head (fork or same-project) as
      // refs/merge-requests/<iid>/head on the target project. Using that
      // ref lets us snapshot fork MRs without configuring the fork as a
      // remote — same SHA-as-baseBranch shape as the gh-side branch above.
      if (isCrossRepository) {
        const mrRef = `refs/merge-requests/${args.mrIid}/head`
        try {
          await gitExecFileAsync(['fetch', remote, mrRef], { cwd: repo.path })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { error: `Failed to fetch ${mrRef}: ${message.split('\n')[0]}` }
        }
        let sha: string
        try {
          const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', 'FETCH_HEAD'], {
            cwd: repo.path
          })
          sha = stdout.trim()
        } catch {
          return { error: `Could not resolve fork MR !${args.mrIid} head after fetch.` }
        }
        if (!sha) {
          return { error: `Empty SHA resolving fork MR !${args.mrIid} head.` }
        }
        return { baseBranch: sha }
      }

      try {
        await gitExecFileAsync(['fetch', remote, sourceBranch], { cwd: repo.path })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { error: `Failed to fetch ${remote}/${sourceBranch}: ${message.split('\n')[0]}` }
      }

      const remoteRef = `${remote}/${sourceBranch}`
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

      // Why: the renderer-supplied worktreeId contains a filesystem path.
      // Re-derive the canonical path from git before any destructive action.
      const provider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
      const registeredWorktrees = repo.connectionId
        ? await provider!.listWorktrees(repo.path)
        : await listGitWorktrees(repo.path)
      const canonicalWorktreePath = getRegisteredDeletableWorktree(
        repo.path,
        worktreePath,
        registeredWorktrees
      ).path
      const removedMeta = store.getWorktreeMeta(args.worktreeId)
      const removedPushTarget = removedMeta?.pushTarget
      const deleteBranch = removedMeta?.preserveBranchOnDelete !== true

      if (repo.connectionId) {
        await (deleteBranch
          ? provider!.removeWorktree(canonicalWorktreePath, args.force)
          : provider!.removeWorktree(canonicalWorktreePath, args.force, { deleteBranch }))
        await cleanupUnusedWorktreePushTargetRemoteSsh(
          provider!,
          repo.path,
          args.worktreeId,
          removedPushTarget,
          store
        )
        runtime.clearOptimisticReconcileToken(args.worktreeId)
        store.removeWorktreeMeta(args.worktreeId)
        deleteWorktreeHistoryDir(args.worktreeId)
        notifyWorktreesChanged(mainWindow, repoId)
        return
      }

      // Run archive hook before removal
      const hooks = getEffectiveHooks(repo)
      if (hooks?.scripts.archive && !args.skipArchive) {
        const result = await runHook('archive', canonicalWorktreePath, repo)
        if (!result.success) {
          console.error(`[hooks] archive hook failed for ${canonicalWorktreePath}:`, result.output)
        }
      }

      // Why: `git worktree remove` (non-force) refuses to delete a worktree
      // that has untracked files, and a symlink pointing into the primary
      // checkout looks untracked to git. Unlink the user-configured symlinks
      // first so the normal delete path keeps working — otherwise every
      // deletion would require the Force Delete toast once the feature is on.
      if (repo.symlinkPaths && repo.symlinkPaths.length > 0) {
        await removeWorktreeSymlinks(canonicalWorktreePath, repo.symlinkPaths)
      }

      let shouldTearDownPtys = true
      try {
        await assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false)
      } catch (error) {
        if (!isOrphanCompatiblePreflightError(error)) {
          throw new Error(
            formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
          )
        }
        // Why: orphan cleanup does not need live shells to be killed first,
        // and preflight did not prove the worktree is cleanly removable.
        shouldTearDownPtys = false
      }

      if (shouldTearDownPtys) {
        // Why: once preflight proves normal deletion is clean, kill PTYs before
        // git-level removal so shells cannot keep the directory busy.
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

      try {
        await (deleteBranch
          ? removeWorktree(repo.path, canonicalWorktreePath, args.force ?? false)
          : removeWorktree(repo.path, canonicalWorktreePath, args.force ?? false, {
              deleteBranch
            }))
      } catch (error) {
        // If git no longer tracks this worktree, clean up the directory and metadata
        if (isOrphanedWorktreeError(error)) {
          console.warn(
            `[worktrees] Orphaned worktree detected at ${canonicalWorktreePath}, cleaning up`
          )
          if (await canSafelyRemoveOrphanedWorktreeDirectory(canonicalWorktreePath, repo.path)) {
            await rm(canonicalWorktreePath, { recursive: true, force: true }).catch(() => {})
          } else {
            console.warn(
              `[worktrees] Refusing recursive cleanup for unproven worktree directory: ${canonicalWorktreePath}`
            )
          }
          // Why: `git worktree remove` failed, so git's internal worktree tracking
          // (`.git/worktrees/<name>`) is still intact. Without pruning, `git worktree
          // list` continues to show the stale entry and the branch it had checked out
          // remains locked — other worktrees cannot check it out.
          await gitExecFileAsync(['worktree', 'prune'], { cwd: repo.path }).catch(() => {})
          await cleanupUnusedWorktreePushTargetRemote(
            repo.path,
            args.worktreeId,
            removedPushTarget,
            store
          )
          runtime.clearOptimisticReconcileToken(args.worktreeId)
          store.removeWorktreeMeta(args.worktreeId)
          deleteWorktreeHistoryDir(args.worktreeId)
          invalidateAuthorizedRootsCache()
          notifyWorktreesChanged(mainWindow, repoId)
          return
        }
        throw new Error(
          formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
        )
      }
      await cleanupUnusedWorktreePushTargetRemote(
        repo.path,
        args.worktreeId,
        removedPushTarget,
        store
      )
      runtime.clearOptimisticReconcileToken(args.worktreeId)
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

  ipcMain.handle('worktrees:listLineage', async () => {
    await runtime.hydrateInferredWorktreeLineage()
    return store.getAllWorktreeLineage()
  })

  ipcMain.handle(
    'worktrees:updateLineage',
    async (_event, args: { worktreeId: string; parentWorktreeId?: string; noParent?: boolean }) => {
      await runtime.updateManagedWorktreeMeta(args.worktreeId, {
        lineage:
          args.noParent === true
            ? { noParent: true }
            : args.parentWorktreeId
              ? { parentWorktree: `id:${args.parentWorktreeId}` }
              : undefined
      })
      notifyWorktreesChanged(mainWindow, parseWorktreeId(args.worktreeId).repoId)
      return store.getWorktreeLineage(args.worktreeId) ?? null
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

  ipcMain.handle('hooks:check', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return { hasHooks: false, hooks: null, mayNeedUpdate: false }
    }

    if (repo.connectionId) {
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      if (!fsProvider) {
        return { hasHooks: false, hooks: null, mayNeedUpdate: false }
      }
      try {
        const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
        return {
          hasHooks: !result.isBinary,
          hooks: result.isBinary ? null : parseOrcaYaml(result.content),
          mayNeedUpdate: false
        }
      } catch {
        return { hasHooks: false, hooks: null, mayNeedUpdate: false }
      }
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

  ipcMain.handle('hooks:inspectSetupScriptImports', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return []
    }

    return inspectSetupScriptImportCandidates(async (relativePath) => {
      const filePath = joinWorktreeRelativePath(repo.path, relativePath)
      if (repo.connectionId) {
        const fsProvider = getSshFilesystemProvider(repo.connectionId)
        if (!fsProvider) {
          return null
        }
        try {
          const result = await fsProvider.readFile(filePath)
          return result.isBinary ? null : result.content
        } catch {
          return null
        }
      }

      try {
        return await readFile(filePath, 'utf-8')
      } catch (error) {
        if (!isENOENT(error)) {
          console.warn('[hooks] Failed to inspect setup script import candidate:', error)
        }
        return null
      }
    })
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
