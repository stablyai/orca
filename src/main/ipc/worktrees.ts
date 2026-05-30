/* oxlint-disable max-lines */
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { readFile, rm, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import { inspectSetupScriptImportCandidates } from '../../shared/setup-script-imports'
import { deleteWorktreeHistoryDir } from '../terminal-history'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  DetectedWorktree,
  DetectedWorktreeListResult,
  GitPushTarget,
  GitWorktreeInfo,
  OrcaHooks,
  Repo,
  Worktree,
  WorktreeMeta
} from '../../shared/types'
import {
  buildKnownOrcaWorkspaceLayouts,
  isLegacyRepoForExternalWorktreeVisibility,
  toDetectedWorktree
} from '../../shared/worktree-ownership'
import {
  assertWorktreeCleanForRemoval,
  listWorktrees as listGitWorktrees,
  removeWorktree
} from '../git/worktree'
import { gitExecFileAsync } from '../git/runner'
import { withWorktreeSpan } from '../observability/instrumentation'
import { resolveGitHubPrStartPoint } from '../github/pr-start-point'
import { getDefaultRemote } from '../git/repo'
import { listRepoWorktrees } from '../repo-worktrees'
import { getSshGitProvider, requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  createIssueCommandRunnerScript,
  getEffectiveHooks,
  getEffectiveHooksFromConfig,
  getSetupRunnerEnvVars,
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
  assertWorktreeDoesNotContainRegisteredWorktree,
  canCleanupUnregisteredOrcaWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  findRegisteredDeletableWorktree,
  isWorktreePathMissing,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE,
  stripOrcaProvenanceMetaUpdates
} from '../worktree-removal-safety'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree-id'

const WORKTREE_ARCHIVE_HOOK_TIMEOUT_MS = 120_000

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

async function isAlreadyRemovedWorktreePath(repo: Repo, worktreePath: string): Promise<boolean> {
  if (!repo.connectionId) {
    return isWorktreePathMissing(worktreePath)
  }

  const fsProvider = getSshFilesystemProvider(repo.connectionId)
  if (!fsProvider) {
    return false
  }
  return isWorktreePathMissing(worktreePath, (path) => fsProvider.stat(path))
}

function getWorktreeRemovalOptionsKey(args: { force?: boolean; skipArchive?: boolean }): string {
  const forceKey = args.force === true ? 'force' : 'normal'
  const archiveKey = args.skipArchive === true ? 'skip-archive' : 'run-archive'
  return `${forceKey}:${archiveKey}`
}

async function getArchiveHooksForRemoval(repo: Repo): Promise<OrcaHooks | null> {
  if (!repo.connectionId) {
    return getEffectiveHooks(repo)
  }

  const fsProvider = getSshFilesystemProvider(repo.connectionId)
  if (!fsProvider) {
    return getEffectiveHooksFromConfig(repo, null)
  }

  try {
    const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
    const yamlHooks = result.isBinary ? null : parseOrcaYaml(result.content)
    return getEffectiveHooksFromConfig(repo, yamlHooks)
  } catch {
    return getEffectiveHooksFromConfig(repo, null)
  }
}

async function runRemoteArchiveHook(
  repo: Repo,
  worktreePath: string,
  script: string
): Promise<{ success: boolean; output: string }> {
  if (!repo.connectionId) {
    return { success: true, output: '' }
  }

  const provider = requireSshGitProvider(repo.connectionId)
  const env = getSetupRunnerEnvVars(repo, worktreePath)
  const isWindowsRemote = isWindowsAbsolutePathLike(worktreePath)
  const result = await provider
    .execNonInteractive(
      isWindowsRemote ? 'cmd.exe' : '/bin/bash',
      isWindowsRemote ? ['/d', '/s', '/c', script] : ['-lc', script],
      worktreePath,
      WORKTREE_ARCHIVE_HOOK_TIMEOUT_MS,
      undefined,
      env
    )
    .catch((error) => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: error instanceof Error ? error.message : String(error)
    }))
  const output = [
    result.stdout,
    result.stderr,
    result.spawnError,
    result.timedOut ? 'archive hook timed out' : null,
    typeof result.exitCode === 'number' && result.exitCode !== 0
      ? `archive hook exited ${result.exitCode}`
      : null
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n')
    .trim()

  return {
    success: !result.spawnError && !result.timedOut && result.exitCode === 0,
    output
  }
}

type WorktreeRemovalInFlight = {
  optionsKey: string
  promise: Promise<void>
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

function buildDetectedGitWorktrees(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): DetectedWorktree[] {
  const settings = store.getSettings()
  const knownOrcaLayouts = repo.connectionId ? [] : buildKnownOrcaWorkspaceLayouts(settings, repo)
  const isLegacyRepoForVisibility = isLegacyRepoForExternalWorktreeVisibility(repo)
  return gitWorktrees.map((gitWorktree) => {
    const worktreeId = `${repo.id}::${gitWorktree.path}`
    let meta = store.getWorktreeMeta(worktreeId)
    const worktree = mergeWorktree(repo.id, gitWorktree, meta, repo.displayName)
    const detected = toDetectedWorktree({
      repo,
      worktree,
      meta,
      settings,
      knownOrcaLayouts,
      isLegacyRepoForVisibility
    })
    if (!detected.visible) {
      return detected
    }

    meta = resolveWorktreeMetaWithDiscoveryStamp(store, worktreeId)
    return toDetectedWorktree({
      repo,
      worktree: mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
      meta,
      settings,
      knownOrcaLayouts,
      isLegacyRepoForVisibility
    })
  })
}

function stampAndMergeVisibleDetectedWorktree(
  store: Store,
  repo: Repo,
  detected: DetectedWorktree
) {
  const meta = resolveWorktreeMetaWithDiscoveryStamp(store, detected.id)
  return mergeWorktree(repo.id, detected, meta, repo.displayName)
}

function getFolderWorkspaceRootId(repo: Repo): string {
  return `${repo.id}::${repo.path}`
}

function getFolderWorkspaceInstanceId(repo: Repo, instanceId: string): string {
  return `${getFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}${instanceId}`
}

function getFolderWorkspaceInstanceIdentity(repo: Repo, worktreeId: string): string {
  const prefix = `${getFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  return worktreeId.startsWith(prefix) ? worktreeId.slice(prefix.length) : randomUUID()
}

function isFolderWorkspaceIdForRepo(repo: Repo, worktreeId: string): boolean {
  const rootId = getFolderWorkspaceRootId(repo)
  return (
    worktreeId === rootId ||
    worktreeId.startsWith(`${rootId}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`)
  )
}

function mergeFolderWorkspace(repo: Repo, worktreeId: string, meta: WorktreeMeta): Worktree {
  return {
    id: worktreeId,
    ...(meta.instanceId !== undefined ? { instanceId: meta.instanceId } : {}),
    repoId: repo.id,
    path: repo.path,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: worktreeId === getFolderWorkspaceRootId(repo),
    displayName: meta.displayName || repo.displayName,
    comment: meta.comment || '',
    linkedIssue: meta.linkedIssue ?? null,
    linkedPR: meta.linkedPR ?? null,
    linkedLinearIssue: meta.linkedLinearIssue ?? null,
    linkedGitLabMR: meta.linkedGitLabMR ?? null,
    linkedGitLabIssue: meta.linkedGitLabIssue ?? null,
    isArchived: meta.isArchived ?? false,
    isUnread: meta.isUnread ?? false,
    isPinned: meta.isPinned ?? false,
    sortOrder: meta.sortOrder ?? 0,
    ...(meta.manualOrder !== undefined ? { manualOrder: meta.manualOrder } : {}),
    lastActivityAt: meta.lastActivityAt ?? 0,
    ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
    ...(meta.createdWithAgent !== undefined ? { createdWithAgent: meta.createdWithAgent } : {}),
    workspaceStatus: meta.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
    diffComments: meta.diffComments
  }
}

function listFolderWorkspaces(store: Store, repo: Repo): Worktree[] {
  const rootId = getFolderWorkspaceRootId(repo)
  const allMeta = store.getAllWorktreeMeta()
  const ids = Object.keys(allMeta).filter((worktreeId) =>
    isFolderWorkspaceIdForRepo(repo, worktreeId)
  )
  if (!ids.includes(rootId)) {
    ids.unshift(rootId)
  }

  return ids
    .map((worktreeId) => {
      const existing = allMeta[worktreeId]
      const meta = existing?.instanceId
        ? existing
        : store.setWorktreeMeta(worktreeId, {
            instanceId: getFolderWorkspaceInstanceIdentity(repo, worktreeId),
            ...(existing ? {} : { displayName: repo.displayName, lastActivityAt: Date.now() })
          })
      return mergeFolderWorkspace(repo, worktreeId, meta)
    })
    .sort((a, b) => {
      if (a.id === rootId) {
        return -1
      }
      if (b.id === rootId) {
        return 1
      }
      return (b.createdAt ?? b.lastActivityAt) - (a.createdAt ?? a.lastActivityAt)
    })
}

function buildFolderDetectedWorktrees(store: Store, repo: Repo): DetectedWorktree[] {
  const settings = store.getSettings()
  return listFolderWorkspaces(store, repo).map((worktree) =>
    toDetectedWorktree({
      repo,
      worktree,
      meta: store.getWorktreeMeta(worktree.id),
      settings,
      knownOrcaLayouts: [],
      isLegacyRepoForVisibility: true
    })
  )
}

function listVisibleFolderWorkspaces(store: Store, repo: Repo): Worktree[] {
  return buildFolderDetectedWorktrees(store, repo)
    .filter((worktree) => worktree.visible)
    .map((worktree) => {
      const meta = store.getWorktreeMeta(worktree.id)
      return mergeFolderWorkspace(repo, worktree.id, meta ?? store.setWorktreeMeta(worktree.id, {}))
    })
}

function createFolderWorkspace(
  args: CreateWorktreeArgs,
  repo: Repo,
  store: Store
): CreateWorktreeResult {
  const now = Date.now()
  const instanceId = randomUUID()
  const worktreeId = getFolderWorkspaceInstanceId(repo, instanceId)
  const meta = store.setWorktreeMeta(worktreeId, {
    instanceId,
    displayName: args.displayName || args.name,
    lastActivityAt: now,
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'desktop',
    ...(args.createdWithAgent ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {})
  })
  return { worktree: mergeFolderWorkspace(repo, worktreeId, meta) }
}

function buildDisconnectedDetectedWorktrees(
  store: Store,
  repo: Repo,
  worktrees: Worktree[]
): DetectedWorktree[] {
  const settings = store.getSettings()
  return worktrees.map((worktree) => {
    const meta = store.getWorktreeMeta(worktree.id)
    const detected = toDetectedWorktree({
      repo,
      worktree,
      meta,
      settings,
      knownOrcaLayouts: [],
      isLegacyRepoForVisibility: true
    })
    return {
      ...detected,
      visible: true,
      ownership: detected.ownership === 'orca-managed' ? 'orca-managed' : 'unknown-legacy'
    }
  })
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
  ipcMain.removeHandler('worktrees:listDetected')
  ipcMain.removeHandler('worktrees:create')
  ipcMain.removeHandler('worktrees:resolvePrBase')
  ipcMain.removeHandler('worktrees:resolveMrBase')
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
            return listVisibleFolderWorkspaces(store, repo)
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
          return buildDetectedGitWorktrees(store, repo, gitWorktrees)
            .filter((worktree) => worktree.visible)
            .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repo, worktree))
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
        return listVisibleFolderWorkspaces(store, repo)
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
      return buildDetectedGitWorktrees(store, repo, gitWorktrees)
        .filter((worktree) => worktree.visible)
        .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repo, worktree))
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
    'worktrees:listDetected',
    async (_event, args: { repoId: string }): Promise<DetectedWorktreeListResult> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return {
          repoId: args.repoId,
          authoritative: false,
          source: 'metadata-fallback',
          worktrees: []
        }
      }
      const sshWorktreeMetaIndex = repo.connectionId
        ? createSshWorktreeMetaIndex(Object.entries(store.getAllWorktreeMeta()))
        : new Map()

      try {
        let gitWorktrees: GitWorktreeInfo[]
        if (isFolderRepo(repo)) {
          return {
            repoId: repo.id,
            authoritative: true,
            source: 'git',
            worktrees: buildFolderDetectedWorktrees(store, repo)
          }
        } else if (repo.connectionId) {
          const provider = getSshGitProvider(repo.connectionId)
          if (!provider) {
            const worktrees = listDisconnectedSshWorktrees(repo, sshWorktreeMetaIndex)
            return {
              repoId: repo.id,
              authoritative: false,
              source: 'metadata-fallback',
              worktrees: buildDisconnectedDetectedWorktrees(store, repo, worktrees)
            }
          }
          gitWorktrees = await provider.listWorktrees(repo.path)
        } else {
          gitWorktrees = await listRepoWorktrees(repo)
        }
        rememberLocalWorktreeRoots(store, repo, gitWorktrees)
        pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
        loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
        return {
          repoId: repo.id,
          authoritative: true,
          source: 'git',
          worktrees: buildDetectedGitWorktrees(store, repo, gitWorktrees)
        }
      } catch (err) {
        warnOnce(
          loggedWorktreeListFailures,
          `${repo.id}:${repo.path}`,
          `[worktrees] failed to list detected worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
          err
        )
        if (repo.connectionId) {
          const worktrees = listDisconnectedSshWorktrees(repo, sshWorktreeMetaIndex)
          return {
            repoId: repo.id,
            authoritative: false,
            source: 'metadata-fallback',
            worktrees: buildDisconnectedDetectedWorktrees(store, repo, worktrees)
          }
        }
        return { repoId: repo.id, authoritative: false, source: 'metadata-fallback', worktrees: [] }
      }
    }
  )

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

        const sourceParse = workspaceSourceSchema.safeParse(args.telemetrySource)
        const source: WorkspaceSource = sourceParse.success ? sourceParse.data : 'unknown'

        let result: CreateWorktreeResult
        try {
          // Why: only wrap the helpers themselves. The pre-validation throws
          // above (`Repo not found`, `Folder mode does not support creating
          // worktrees`) signal IPC-shape bugs, not the user-visible
          // git/filesystem failures the funnel cares about — bucketing them
          // into `unknown` would pollute the failure taxonomy.
          result = isFolderRepo(repo)
            ? createFolderWorkspace(args, repo, store)
            : repo.connectionId
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
          from_existing_branch:
            !isFolderRepo(repo) &&
            typeof args.baseBranch === 'string' &&
            args.baseBranch.length > 0,
          ...getCohortAtEmit()
        })

        if (isFolderRepo(repo)) {
          notifyWorktreesChanged(mainWindow, repo.id)
        }

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

  // Why: keep desktop IPC and mobile/runtime RPC on the same MR base
  // resolution path so SSH repos do not regress differently by surface.
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
    ): Promise<{ baseBranch: string; pushTarget?: GitPushTarget } | { error: string }> => {
      return runtime.resolveManagedMrBase({
        repoSelector: `id:${args.repoId}`,
        mrIid: args.mrIid,
        sourceBranch: args.sourceBranch,
        isCrossRepository: args.isCrossRepository
      })
    }
  )

  const worktreeRemovalsInFlight = new Map<string, WorktreeRemovalInFlight>()

  ipcMain.handle(
    'worktrees:remove',
    async (_event, args: { worktreeId: string; force?: boolean; skipArchive?: boolean }) => {
      const optionsKey = getWorktreeRemovalOptionsKey(args)
      const inFlightRemoval = worktreeRemovalsInFlight.get(args.worktreeId)
      if (inFlightRemoval) {
        if (inFlightRemoval.optionsKey === optionsKey) {
          return inFlightRemoval.promise
        }
        throw new Error(`Worktree deletion already in progress: ${args.worktreeId}`)
      }

      // Why: stale toast actions, double-clicks, and Space/sidebar races can
      // target the same worktree concurrently. Share the destructive backend
      // operation so only one path touches Git and the filesystem.
      const removal = (async (): Promise<void> => {
        const { repoId, worktreePath } = parseWorktreeId(args.worktreeId)
        const repo = store.getRepo(repoId)
        if (!repo) {
          throw new Error(`Repo not found: ${repoId}`)
        }
        if (isFolderRepo(repo)) {
          if (args.worktreeId === getFolderWorkspaceRootId(repo)) {
            throw new Error(
              'Cannot delete the project root workspace. Remove the folder project instead.'
            )
          }
          // Why: folder workspaces share one filesystem root, so there is no Git
          // remove step to close shells; sweep PTYs before dropping metadata.
          await killAllProcessesForWorktree(args.worktreeId, {
            runtime,
            localProvider: getLocalPtyProvider()
          }).catch((err) => {
            console.warn(`[worktree-teardown] failed for ${args.worktreeId}:`, err)
          })
          store.removeWorktreeMeta(args.worktreeId)
          deleteWorktreeHistoryDir(args.worktreeId)
          notifyWorktreesChanged(mainWindow, repoId)
          return
        }

        // Why: the renderer-supplied worktreeId contains a filesystem path.
        // Re-derive the canonical path from git before any destructive action.
        const provider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
        const registeredWorktrees = repo.connectionId
          ? await provider!.listWorktrees(repo.path)
          : await listGitWorktrees(repo.path)
        const removedMeta = store.getWorktreeMeta(args.worktreeId)
        const removedPushTarget = removedMeta?.pushTarget
        const registeredWorktree = findRegisteredDeletableWorktree(
          repo.path,
          worktreePath,
          registeredWorktrees
        )
        if (!registeredWorktree) {
          const fsProvider = repo.connectionId ? getSshFilesystemProvider(repo.connectionId) : null
          let canCleanOrphanedDirectory = false
          const knownOrcaLayouts = repo.connectionId
            ? []
            : buildKnownOrcaWorkspaceLayouts(store.getSettings(), repo)
          if (
            canCleanupUnregisteredOrcaWorktreeDirectory({
              meta: removedMeta,
              worktreePath,
              repo,
              knownOrcaLayouts
            })
          ) {
            if (repo.connectionId) {
              if (!fsProvider) {
                throw new Error('SSH filesystem provider unavailable')
              }
              if (!fsProvider.lstat) {
                throw new Error('SSH filesystem provider lstat unavailable')
              }
              canCleanOrphanedDirectory = await canSafelyRemoveOrphanedWorktreeDirectory(
                worktreePath,
                repo.path,
                (path) => fsProvider.lstat!(path),
                (path) => fsProvider.readFile(path)
              )
            } else {
              canCleanOrphanedDirectory = await canSafelyRemoveOrphanedWorktreeDirectory(
                worktreePath,
                repo.path
              )
            }
          }
          if (canCleanOrphanedDirectory) {
            assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, registeredWorktrees)
            if (!args.force) {
              throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
            }
            if (repo.connectionId) {
              await fsProvider!.deletePath(worktreePath, true)
              await cleanupUnusedWorktreePushTargetRemoteSsh(
                provider!,
                repo.path,
                args.worktreeId,
                removedPushTarget,
                store
              )
            } else {
              await rm(worktreePath, { recursive: true, force: true })
              await cleanupUnusedWorktreePushTargetRemote(
                repo.path,
                args.worktreeId,
                removedPushTarget,
                store
              )
              invalidateAuthorizedRootsCache()
            }
            runtime.clearOptimisticReconcileToken(args.worktreeId)
            store.removeWorktreeMeta(args.worktreeId)
            deleteWorktreeHistoryDir(args.worktreeId)
            notifyWorktreesChanged(mainWindow, repoId)
            return
          }
          if (args.force && (await isAlreadyRemovedWorktreePath(repo, worktreePath))) {
            // Why: Force-delete can be retried from stale UI after a prior delete
            // already removed the directory and Git registration. Treat that as
            // successful cleanup, but do not delete any unregistered existing path.
            if (repo.connectionId) {
              await cleanupUnusedWorktreePushTargetRemoteSsh(
                provider!,
                repo.path,
                args.worktreeId,
                removedPushTarget,
                store
              )
            } else {
              await cleanupUnusedWorktreePushTargetRemote(
                repo.path,
                args.worktreeId,
                removedPushTarget,
                store
              )
              invalidateAuthorizedRootsCache()
            }
            runtime.clearOptimisticReconcileToken(args.worktreeId)
            store.removeWorktreeMeta(args.worktreeId)
            deleteWorktreeHistoryDir(args.worktreeId)
            notifyWorktreesChanged(mainWindow, repoId)
            return
          }
          throw new Error(`Refusing to delete unregistered worktree path: ${worktreePath}`)
        }
        const canonicalWorktreePath = registeredWorktree.path
        const deleteBranch = removedMeta?.preserveBranchOnDelete !== true

        let shouldTearDownPtys = true

        // Run archive hook before removal so teardown scripts still see the worktree directory.
        const hooks = await getArchiveHooksForRemoval(repo)
        if (hooks?.scripts.archive && !args.skipArchive) {
          const result = repo.connectionId
            ? await runRemoteArchiveHook(repo, canonicalWorktreePath, hooks.scripts.archive)
            : await runHook('archive', canonicalWorktreePath, repo)
          if (!result.success) {
            console.error(
              `[hooks] archive hook failed for ${canonicalWorktreePath}:`,
              result.output
            )
          }
        }

        if (repo.connectionId) {
          // Why: SSH deletion mirrors the local flow: hooks run while the
          // directory is intact, then the clean check guards destructive removal.
          if (!args.force) {
            const { clean, stdout } = await provider!.worktreeIsClean(canonicalWorktreePath)
            if (!clean) {
              const error = new Error('Worktree has uncommitted or untracked changes.')
              ;(error as Error & { stdout?: string }).stdout = stdout
              throw error
            }
          }

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

        // Why: `git worktree remove` (non-force) refuses to delete a worktree
        // that has untracked files, and a symlink pointing into the primary
        // checkout looks untracked to git. Unlink the user-configured symlinks
        // first so the normal delete path keeps working — otherwise every
        // deletion would require the Force Delete toast once the feature is on.
        if (repo.symlinkPaths && repo.symlinkPaths.length > 0) {
          await removeWorktreeSymlinks(canonicalWorktreePath, repo.symlinkPaths)
        }

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
      })()
      worktreeRemovalsInFlight.set(args.worktreeId, { optionsKey, promise: removal })
      try {
        await removal
      } finally {
        if (worktreeRemovalsInFlight.get(args.worktreeId)?.promise === removal) {
          worktreeRemovalsInFlight.delete(args.worktreeId)
        }
      }
    }
  )

  ipcMain.handle(
    'worktrees:updateMeta',
    (_event, args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => {
      const meta = store.setWorktreeMeta(
        args.worktreeId,
        stripOrcaProvenanceMetaUpdates(args.updates)
      )
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
      return { status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false }
    }

    if (repo.connectionId) {
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      if (!fsProvider) {
        return { status: 'error', hasHooks: false, hooks: null, mayNeedUpdate: false }
      }
      try {
        const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
        return {
          status: 'ok',
          hasHooks: !result.isBinary,
          hooks: result.isBinary ? null : parseOrcaYaml(result.content),
          mayNeedUpdate: false
        }
      } catch (error) {
        return {
          status: isENOENT(error) ? 'ok' : 'error',
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }
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
      status: 'ok',
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

    return inspectSetupScriptImportCandidates(
      async (relativePath) => {
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
      },
      {
        fileExists: async (relativePath) => {
          const filePath = joinWorktreeRelativePath(repo.path, relativePath)
          if (repo.connectionId) {
            const fsProvider = getSshFilesystemProvider(repo.connectionId)
            if (!fsProvider) {
              return false
            }
            try {
              const fileStat = await fsProvider.stat(filePath)
              return fileStat.type !== 'directory'
            } catch {
              return false
            }
          }

          try {
            const fileStat = await stat(filePath)
            return !fileStat.isDirectory()
          } catch (error) {
            if (!isENOENT(error)) {
              console.warn('[hooks] Failed to stat setup script import candidate:', error)
            }
            return false
          }
        }
      }
    )
  })

  ipcMain.handle('hooks:readIssueCommand', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return {
        status: 'ok',
        localContent: null,
        sharedContent: null,
        effectiveContent: null,
        localFilePath: '',
        source: 'none' as const
      }
    }
    if (repo.connectionId) {
      const issueCommandPath = joinWorktreeRelativePath(repo.path, '.orca/issue-command')
      const fsProvider = getSshFilesystemProvider(repo.connectionId)
      if (!fsProvider) {
        return {
          status: 'error',
          localContent: null,
          sharedContent: null,
          effectiveContent: null,
          localFilePath: issueCommandPath,
          source: 'none' as const
        }
      }

      let status: 'ok' | 'error' = 'ok'
      let localContent: string | null = null
      let sharedContent: string | null = null
      try {
        const result = await fsProvider.readFile(issueCommandPath)
        localContent = result.isBinary ? null : result.content.trim() || null
      } catch (error) {
        if (!isENOENT(error)) {
          status = 'error'
        }
      }
      try {
        const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
        sharedContent = result.isBinary
          ? null
          : parseOrcaYaml(result.content)?.issueCommand?.trim() || null
      } catch (error) {
        if (!isENOENT(error)) {
          status = 'error'
        }
      }
      const effectiveContent = localContent ?? sharedContent
      return {
        status: localContent ? 'ok' : status,
        localContent,
        sharedContent,
        effectiveContent,
        localFilePath: issueCommandPath,
        source: localContent
          ? ('local' as const)
          : sharedContent
            ? ('shared' as const)
            : ('none' as const)
      }
    }
    return readIssueCommand(repo.path)
  })

  ipcMain.handle(
    'hooks:writeIssueCommand',
    async (_event, args: { repoId: string; content: string }) => {
      const repo = store.getRepo(args.repoId)
      if (!repo || isFolderRepo(repo)) {
        return
      }
      if (repo.connectionId) {
        const issueCommandPath = joinWorktreeRelativePath(repo.path, '.orca/issue-command')
        const fsProvider = getSshFilesystemProvider(repo.connectionId)
        if (!fsProvider) {
          throw new Error(
            'Remote filesystem unavailable. Reconnect the SSH target before retrying.'
          )
        }
        const trimmed = args.content.trim()
        if (!trimmed) {
          await fsProvider.deletePath(issueCommandPath, false).catch((error: unknown) => {
            if (!isENOENT(error)) {
              throw error
            }
          })
          return
        }
        await fsProvider.createDir(joinWorktreeRelativePath(repo.path, '.orca'))
        const gitignorePath = joinWorktreeRelativePath(repo.path, '.gitignore')
        try {
          const result = await fsProvider.readFile(gitignorePath)
          if (!result.isBinary && !/^\.orca\/?$/m.test(result.content)) {
            const separator = result.content.endsWith('\n') ? '' : '\n'
            await fsProvider.writeFile(gitignorePath, `${result.content}${separator}.orca\n`)
          }
        } catch (error) {
          if (!isENOENT(error)) {
            throw error
          }
          await fsProvider.writeFile(gitignorePath, '.orca\n')
        }
        await fsProvider.writeFile(issueCommandPath, `${trimmed}\n`)
        return
      }
      writeIssueCommand(repo.path, args.content)
    }
  )
}
