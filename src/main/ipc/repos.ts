/* eslint-disable max-lines -- Why: repo IPC is intentionally centralized so SSH
routing, clone lifecycle, and store persistence stay behind a single audited
boundary. Splitting by line count would scatter tightly coupled repo behavior. */
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import type { Store } from '../persistence'
import type {
  BaseRefSearchResult,
  Repo,
  ProjectGroup,
  ProjectGroupImportResult,
  NestedRepoScanResult,
  BaseRefDefaultResult,
  SparsePreset
} from '../../shared/types'
import { isFolderRepo } from '../../shared/repo-kind'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { normalizeRepoBadgeColor } from '../../shared/repo-badge-color'
import { sanitizeRepoIcon } from '../../shared/repo-icon'
import { normalizeRepoSourceControlAiOverrides } from '../../shared/source-control-ai'
import { invalidateAuthorizedRootsCache } from './filesystem-auth'
import type { ChildProcess } from 'child_process'
import { access, mkdir, readdir, rm } from 'fs/promises'
import { gitExecFileAsync, gitSpawn } from '../git/runner'
import { isAbsolute, join, posix } from 'path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  cleanupClaimedCloneTarget,
  claimCloneTarget,
  deriveValidatedClonePath,
  getClonePathComparisonKey
} from '../git/repo-clone-path'
import type { ClaimedCloneTarget } from '../git/repo-clone-path'
import { getNextProjectGroupOrder } from '../../shared/project-groups'
import { scanNestedRepos } from '../project-groups/nested-repo-discovery'
import {
  createNestedProjectGroupResolver,
  resolveNestedRepoSelection
} from '../project-groups/nested-repo-import'
import {
  isGitRepo,
  getGitUsername,
  getRepoName,
  getBaseRefDefault,
  getRemoteCount,
  normalizeRefSearchQuery,
  parseAndFilterSearchRefDetails,
  parseRemoteCount,
  resolveDefaultBaseRefViaExec,
  buildSearchBaseRefsArgv,
  isForEachRefExcludeUnsupportedError,
  searchBaseRefDetails
} from '../git/repo'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSshGitUsername } from '../git/git-username'
import { getActiveMultiplexer } from './ssh'
import { normalizeSparseDirectories } from './sparse-checkout-directories'
import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import type { RepoMethod } from '../../shared/telemetry-events'
import { detectRepoIcon } from '../repo-icon-autodetect'

// Why: `method` answers "which entry point did the user take?", not "what did
// they add?" — so the IPC the renderer invoked IS the method. We never send
// the path, URL, or display name. `repos:create` collapses into
// `folder_picker` because the user's entry was the folder picker, even
// though main also `git init`s. `drag_drop` is reserved for a future call
// site; no current renderer surface produces it.
function emitRepoAdded(method: RepoMethod, alreadyExisted: boolean): void {
  // Why: re-adding an existing repo (matched by path inside the handler)
  // is not a new activation event. Suppressing the duplicate keeps the
  // funnel honest and avoids inflating `repo_added` for users who
  // re-pick the same folder.
  if (alreadyExisted) {
    return
  }
  // Why: cohort must read AFTER `store.addRepo()` lands so the just-added
  // repo is counted — every call site below already emits post-addRepo, so
  // `getCohortAtEmit()` here returns the user's Nth `repo_added` as `N`.
  // See docs/onboarding-funnel-cohort-addendum.md §Read-vs-write ordering.
  track('repo_added', { method, ...getCohortAtEmit() })
}

function getRemoteRepoFolderName(remotePath: string): string {
  const trimmed = remotePath.replace(/[\\/]+$/, '')
  if (!trimmed) {
    return remotePath
  }
  return trimmed.split(/[\\/]/).at(-1) || remotePath
}

type ActiveCloneMetadata = {
  path: string
  pathKey: string
  claimedTarget: ClaimedCloneTarget
  process: ChildProcess
  abortRequested: boolean
  generation: number
  pendingAbortCleanup: Promise<void> | null
  resolvePendingAbortCleanup: (() => void) | null
}

// Why: module-scoped so the abort handle survives window re-creation on macOS.
// registerRepoHandlers is called again when a new BrowserWindow is created,
// and a function-scoped variable would lose the reference to an in-flight clone.
let activeClone: ActiveCloneMetadata | null = null
let nextCloneGeneration = 1
const latestCloneGenerationByPath = new Map<string, number>()
const pendingAbortCleanupByPath = new Map<string, Promise<void>>()
const cloneInFlightByPath = new Map<string, Promise<void>>()
const activeNestedRepoScans = new Map<string, AbortController>()
type CompletedNestedRepoScan = {
  scan: NestedRepoScanResult
  parentPath: string
  connectionId: string | null
}
const completedNestedRepoScans = new Map<string, CompletedNestedRepoScan>()
const MAX_COMPLETED_NESTED_SCAN_RESULTS = 50

const ProjectGroupCreateArgs = z.object({
  name: z.string().min(1),
  parentPath: z.string().nullable().optional(),
  parentGroupId: z.string().nullable().optional(),
  createdFrom: z.enum(['manual', 'folder-scan', 'migration']).optional()
})

const ProjectGroupUpdateArgs = z.object({
  groupId: z.string().min(1),
  updates: z.object({
    name: z.string().optional(),
    isCollapsed: z.boolean().optional(),
    tabOrder: z.number().finite().optional(),
    color: z.string().nullable().optional()
  })
})

const ProjectGroupSelectorArgs = z.object({
  groupId: z.string().min(1)
})

const ProjectGroupMoveProjectArgs = z.object({
  projectId: z.string().min(1),
  groupId: z.string().nullable(),
  order: z.number().finite().optional()
})

const ProjectGroupScanNestedArgs = z.object({
  path: z.string().min(1),
  connectionId: z.string().min(1).optional(),
  scanId: z.string().min(1).optional(),
  options: z.unknown().optional()
})

const ProjectGroupCancelNestedScanArgs = z.object({
  scanId: z.string().min(1)
})

const ProjectGroupImportNestedArgs = z.discriminatedUnion('mode', [
  z.object({
    parentPath: z.string().min(1),
    groupName: z.string().min(1),
    projectPaths: z.array(z.string()),
    connectionId: z.string().min(1).optional(),
    scanId: z.string().min(1).optional(),
    mode: z.literal('group')
  }),
  z.object({
    parentPath: z.string().min(1),
    groupName: z.string().optional().default(''),
    projectPaths: z.array(z.string()),
    connectionId: z.string().min(1).optional(),
    scanId: z.string().min(1).optional(),
    mode: z.literal('separate')
  })
])

function parseProjectGroupIpcArgs<T>(schema: z.ZodType<T>, value: unknown, errorCode: string): T {
  const result = schema.safeParse(value)
  if (result.success) {
    return result.data
  }
  throw new Error(errorCode)
}

function validateNestedRepoScanRoot(path: string, connectionId?: string): void {
  if (connectionId) {
    return
  }
  if (!isAbsolute(path)) {
    throw new Error('Repo path must be an absolute path')
  }
}

function rememberCompletedNestedRepoScan(
  scanId: string | undefined,
  context: { parentPath: string; connectionId?: string },
  scan: NestedRepoScanResult
): void {
  if (!scanId) {
    return
  }
  completedNestedRepoScans.set(scanId, {
    scan,
    parentPath: scan.selectedPath,
    connectionId: context.connectionId ?? null
  })
  while (completedNestedRepoScans.size > MAX_COMPLETED_NESTED_SCAN_RESULTS) {
    const oldestScanId = completedNestedRepoScans.keys().next().value
    if (!oldestScanId) {
      break
    }
    completedNestedRepoScans.delete(oldestScanId)
  }
}

function getCompletedNestedRepoScan(args: {
  scanId?: string
  parentPath: string
  connectionId?: string
}): NestedRepoScanResult | undefined {
  if (!args.scanId) {
    return undefined
  }
  const completed = completedNestedRepoScans.get(args.scanId)
  if (!completed) {
    return undefined
  }
  if (
    completed.connectionId !== (args.connectionId ?? null) ||
    normalizeRuntimePathForComparison(completed.parentPath) !==
      normalizeRuntimePathForComparison(args.parentPath)
  ) {
    return undefined
  }
  return completed.scan
}

async function cleanupOwnedCloneTarget(metadata: ActiveCloneMetadata): Promise<void> {
  if (!metadata.claimedTarget.canCleanup || !metadata.claimedTarget.ownedDirectoryIdentity) {
    return
  }
  if (latestCloneGenerationByPath.get(metadata.pathKey) !== metadata.generation) {
    return
  }
  // Why: an immediate retry can attach a newer process to the same target
  // before the aborted process closes; the old close handler must not delete it.
  if (
    activeClone &&
    activeClone.process !== metadata.process &&
    activeClone.pathKey === metadata.pathKey
  ) {
    return
  }

  if (latestCloneGenerationByPath.get(metadata.pathKey) !== metadata.generation) {
    return
  }
  await cleanupClaimedCloneTarget(metadata.path, metadata.claimedTarget)
}

function markCloneAbortCleanupPending(metadata: ActiveCloneMetadata): void {
  if (metadata.resolvePendingAbortCleanup) {
    return
  }
  metadata.pendingAbortCleanup = new Promise<void>((resolve) => {
    metadata.resolvePendingAbortCleanup = resolve
  })
  pendingAbortCleanupByPath.set(metadata.pathKey, metadata.pendingAbortCleanup)
}

function settleCloneAbortCleanup(metadata: ActiveCloneMetadata): void {
  if (pendingAbortCleanupByPath.get(metadata.pathKey) === metadata.pendingAbortCleanup) {
    pendingAbortCleanupByPath.delete(metadata.pathKey)
  }
  metadata.resolvePendingAbortCleanup?.()
  metadata.pendingAbortCleanup = null
  metadata.resolvePendingAbortCleanup = null
}

async function runWithClonePathLock<T>(clonePathKey: string, task: () => Promise<T>): Promise<T> {
  const previous = cloneInFlightByPath.get(clonePathKey) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(
    () => current,
    () => current
  )
  cloneInFlightByPath.set(clonePathKey, tail)

  try {
    await previous
    return await task()
  } finally {
    release()
    if (cloneInFlightByPath.get(clonePathKey) === tail) {
      cloneInFlightByPath.delete(clonePathKey)
    }
  }
}

function sanitizeNestedRepoImportError(context: string, error: unknown): string {
  console.warn(`[project-groups] ${context}`, error)
  return 'Repository could not be imported'
}

async function resolveSshProjectGroupPath(connectionId: string, path: string): Promise<string> {
  if (path === '~' || path === '~/' || path.startsWith('~/')) {
    const mux = getActiveMultiplexer(connectionId)
    if (mux) {
      try {
        const result = (await mux.request('session.resolveHome', { path })) as {
          resolvedPath: string
        }
        return result.resolvedPath
      } catch {
        return path
      }
    }
  }
  return path
}

async function scanNestedReposForIpc(args: {
  path: string
  connectionId?: string
  options?: unknown
  signal?: AbortSignal
  onProgress?: (scan: NestedRepoScanResult) => void
}): Promise<NestedRepoScanResult> {
  validateNestedRepoScanRoot(args.path, args.connectionId)
  if (!args.connectionId) {
    return scanNestedRepos({
      path: args.path,
      options: args.options,
      signal: args.signal,
      onProgress: args.onProgress
    })
  }
  const gitProvider = getSshGitProvider(args.connectionId)
  const fsProvider = getSshFilesystemProvider(args.connectionId)
  if (!gitProvider || !fsProvider) {
    throw new Error('ssh_connection_unavailable')
  }
  const resolvedPath = await resolveSshProjectGroupPath(args.connectionId, args.path)
  return scanNestedRepos({
    path: resolvedPath,
    options: args.options,
    signal: args.signal,
    onProgress: args.onProgress,
    filesystem: {
      readDirectory: async (dirPath) =>
        (await fsProvider.readDir(dirPath)).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory,
          isSymlink: entry.isSymlink
        })),
      readTextFile: async (filePath) => (await fsProvider.readFile(filePath)).content,
      joinPath: (parentPath, childName) => posix.join(parentPath, childName),
      basename: (path) => posix.basename(path),
      hasGitMarker: async (path) => {
        try {
          const marker = await fsProvider.stat(posix.join(path, '.git'))
          if (marker.type === 'directory' || marker.type === 'file') {
            return true
          }
        } catch {
          // Continue to cheap bare-repository marker checks below.
        }
        const [head, objects, refs] = await Promise.all([
          fsProvider.stat(posix.join(path, 'HEAD')).catch(() => null),
          fsProvider.stat(posix.join(path, 'objects')).catch(() => null),
          fsProvider.stat(posix.join(path, 'refs')).catch(() => null)
        ])
        return head?.type === 'file' && objects?.type === 'directory' && refs?.type === 'directory'
      },
      isSelectedPathGitRepo: async (path) => {
        try {
          return (await gitProvider.isGitRepoAsync(path)).isRepo
        } catch {
          return false
        }
      }
    }
  })
}

async function runNestedRepoScanForIpc(
  event: IpcMainInvokeEvent,
  args: z.infer<typeof ProjectGroupScanNestedArgs>
): Promise<NestedRepoScanResult> {
  const controller = args.scanId ? new AbortController() : undefined
  if (args.scanId && controller) {
    activeNestedRepoScans.get(args.scanId)?.abort()
    activeNestedRepoScans.set(args.scanId, controller)
  }

  try {
    const scan = await scanNestedReposForIpc({
      ...args,
      signal: controller?.signal,
      onProgress: args.scanId
        ? (scan) => {
            event.sender.send('projectGroups:scanNestedProgress', {
              scanId: args.scanId,
              scan
            })
          }
        : undefined
    })
    rememberCompletedNestedRepoScan(
      args.scanId,
      { parentPath: args.path, connectionId: args.connectionId },
      scan
    )
    return scan
  } finally {
    if (args.scanId && activeNestedRepoScans.get(args.scanId) === controller) {
      activeNestedRepoScans.delete(args.scanId)
    }
  }
}

export function registerRepoHandlers(mainWindow: BrowserWindow, store: Store): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('repos:list')
  ipcMain.removeHandler('repos:add')
  ipcMain.removeHandler('repos:remove')
  ipcMain.removeHandler('repos:reorder')
  ipcMain.removeHandler('repos:update')
  ipcMain.removeHandler('projectGroups:list')
  ipcMain.removeHandler('projectGroups:create')
  ipcMain.removeHandler('projectGroups:update')
  ipcMain.removeHandler('projectGroups:delete')
  ipcMain.removeHandler('projectGroups:moveProject')
  ipcMain.removeHandler('projectGroups:scanNested')
  ipcMain.removeHandler('projectGroups:cancelNestedScan')
  ipcMain.removeHandler('projectGroups:importNested')
  ipcMain.removeHandler('repos:pickFolder')
  ipcMain.removeHandler('repos:pickDirectory')
  ipcMain.removeHandler('repos:clone')
  ipcMain.removeHandler('repos:cloneAbort')
  ipcMain.removeHandler('repos:getGitUsername')
  ipcMain.removeHandler('repos:getBaseRefDefault')
  ipcMain.removeHandler('repos:searchBaseRefs')
  ipcMain.removeHandler('repos:searchBaseRefDetails')
  ipcMain.removeHandler('repos:addRemote')
  ipcMain.removeHandler('repos:create')
  ipcMain.removeHandler('sparsePresets:list')
  ipcMain.removeHandler('sparsePresets:save')
  ipcMain.removeHandler('sparsePresets:remove')

  ipcMain.handle('repos:list', () => {
    return store.getRepos()
  })

  ipcMain.handle('projectGroups:list', () => store.getProjectGroups())

  ipcMain.handle('projectGroups:create', (_event, rawArgs: unknown): ProjectGroup => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupCreateArgs,
      rawArgs,
      'invalid_project_group_create_args'
    )
    const group = store.createProjectGroup({
      name: args.name,
      parentPath: args.parentPath ?? null,
      parentGroupId: args.parentGroupId ?? null,
      createdFrom: args.createdFrom ?? 'manual'
    })
    notifyReposChanged(mainWindow)
    return group
  })

  ipcMain.handle('projectGroups:update', (_event, rawArgs: unknown): ProjectGroup | null => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupUpdateArgs,
      rawArgs,
      'invalid_project_group_update_args'
    )
    const updated = store.updateProjectGroup(args.groupId, args.updates)
    if (updated) {
      notifyReposChanged(mainWindow)
    }
    return updated
  })

  ipcMain.handle('projectGroups:delete', (_event, rawArgs: unknown): boolean => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupSelectorArgs,
      rawArgs,
      'invalid_project_group_delete_args'
    )
    const deleted = store.deleteProjectGroup(args.groupId)
    if (deleted) {
      notifyReposChanged(mainWindow)
    }
    return deleted
  })

  ipcMain.handle('projectGroups:moveProject', (_event, rawArgs: unknown): Repo | null => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupMoveProjectArgs,
      rawArgs,
      'invalid_project_group_move_repo_args'
    )
    const moved = store.moveProjectToGroup(args.projectId, args.groupId, args.order)
    if (moved) {
      notifyReposChanged(mainWindow)
    }
    return moved
  })

  ipcMain.handle(
    'projectGroups:scanNested',
    async (event, rawArgs: unknown): Promise<NestedRepoScanResult> => {
      const args = parseProjectGroupIpcArgs(
        ProjectGroupScanNestedArgs,
        rawArgs,
        'invalid_project_group_scan_nested_args'
      )
      return runNestedRepoScanForIpc(event, args)
    }
  )

  ipcMain.handle('projectGroups:cancelNestedScan', (_event, rawArgs: unknown): boolean => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupCancelNestedScanArgs,
      rawArgs,
      'invalid_project_group_cancel_nested_scan_args'
    )
    const controller = activeNestedRepoScans.get(args.scanId)
    if (!controller) {
      return false
    }
    controller.abort()
    return true
  })

  ipcMain.handle(
    'projectGroups:importNested',
    async (_event, rawArgs: unknown): Promise<ProjectGroupImportResult> => {
      const args = parseProjectGroupIpcArgs(
        ProjectGroupImportNestedArgs,
        rawArgs,
        'invalid_project_group_import_nested_args'
      )
      const requestedPaths = args.projectPaths
      const completedScan = getCompletedNestedRepoScan(args)
      const scan =
        completedScan ??
        (await scanNestedReposForIpc({
          path: args.parentPath,
          connectionId: args.connectionId,
          options: { timeoutMs: 15_000 }
        }))
      const selection = resolveNestedRepoSelection({ scan, projectPaths: requestedPaths })
      const groupResolver = createNestedProjectGroupResolver({
        parentPath: scan.selectedPath,
        groupName: args.groupName ?? '',
        mode: args.mode,
        createGroup: (input) => store.createProjectGroup(input)
      })
      const results: ProjectGroupImportResult['projects'] = selection.rejectedPaths.map(
        (repoPath) => ({
          path: repoPath,
          status: 'failed',
          error: 'Repository was not found in the nested repo scan result'
        })
      )

      for (const repoPath of selection.selectedPaths) {
        try {
          if (args.connectionId) {
            const gitProvider = getSshGitProvider(args.connectionId)
            if (!gitProvider || !(await gitProvider.isGitRepoAsync(repoPath)).isRepo) {
              results.push({
                path: repoPath,
                status: 'failed',
                error: 'Not a valid git repository'
              })
              continue
            }
          } else if (!isGitRepo(repoPath)) {
            results.push({ path: repoPath, status: 'failed', error: 'Not a valid git repository' })
            continue
          }
          const existing = store
            .getRepos()
            .find(
              (repo) =>
                (repo.connectionId ?? null) === (args.connectionId ?? null) &&
                normalizeRuntimePathForComparison(repo.path) ===
                  normalizeRuntimePathForComparison(repoPath)
            )
          const group = groupResolver.getGroupForRepo(repoPath)
          if (existing) {
            if (group) {
              store.moveProjectToGroup(existing.id, group.id)
            }
            results.push({ path: repoPath, projectId: existing.id, status: 'already-known' })
            continue
          }
          const repo: Repo = {
            id: randomUUID(),
            path: repoPath,
            displayName: getRepoName(repoPath),
            badgeColor: DEFAULT_REPO_BADGE_COLOR,
            addedAt: Date.now(),
            kind: 'git',
            ...(args.connectionId ? { connectionId: args.connectionId } : {}),
            externalWorktreeVisibility: 'hide',
            externalWorktreeVisibilityLegacy: false,
            ...(group
              ? {
                  projectGroupId: group.id,
                  projectGroupOrder: getNextProjectGroupOrder(store.getRepos(), group.id)
                }
              : {})
          }
          store.addRepo(repo)
          if (args.connectionId) {
            getActiveMultiplexer(args.connectionId)?.notify('session.registerRoot', {
              rootPath: repoPath
            })
          }
          results.push({ path: repoPath, projectId: repo.id, status: 'imported' })
          emitRepoAdded('folder_picker', false)
        } catch (error) {
          results.push({
            path: repoPath,
            status: 'failed',
            error: sanitizeNestedRepoImportError('Failed to import nested repository', error)
          })
        }
      }

      const importedCount = results.filter((entry) => entry.status === 'imported').length
      const alreadyKnownCount = results.filter((entry) => entry.status === 'already-known').length
      const failedCount = results.filter((entry) => entry.status === 'failed').length
      if (importedCount + alreadyKnownCount === 0) {
        for (const group of groupResolver.getCreatedGroups().reverse()) {
          store.deleteProjectGroup(group.id)
        }
      }
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      const rootGroup = groupResolver.getRootGroup()
      return {
        ...(rootGroup && importedCount + alreadyKnownCount > 0 ? { group: rootGroup } : {}),
        projects: results,
        importedCount,
        alreadyKnownCount,
        failedCount
      }
    }
  )

  ipcMain.handle(
    'repos:add',
    async (
      _event,
      args: { path: string; kind?: 'git' | 'folder' }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const repoKind = args.kind === 'folder' ? 'folder' : 'git'
      if (repoKind === 'git' && !isGitRepo(args.path)) {
        return { error: `Not a valid git repository: ${args.path}` }
      }

      // Check if already added
      const existing = store.getRepos().find((r) => r.path === args.path)
      if (existing) {
        emitRepoAdded('folder_picker', true)
        return { repo: existing }
      }

      const repoIcon = await detectRepoIcon({ repoPath: args.path, kind: repoKind })
      const repo: Repo = {
        id: randomUUID(),
        path: args.path,
        displayName: getRepoName(args.path),
        badgeColor: DEFAULT_REPO_BADGE_COLOR,
        ...(repoIcon ? { repoIcon } : {}),
        addedAt: Date.now(),
        kind: repoKind,
        ...(repoKind === 'git'
          ? {
              externalWorktreeVisibility: 'hide' as const,
              externalWorktreeVisibilityLegacy: false
            }
          : {})
      }

      store.addRepo(repo)
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', false)
      return { repo }
    }
  )

  ipcMain.handle(
    'repos:addRemote',
    async (
      _event,
      args: {
        connectionId: string
        remotePath: string
        displayName?: string
        kind?: 'git' | 'folder'
      }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const gitProvider = getSshGitProvider(args.connectionId)
      if (!gitProvider) {
        return { error: `SSH connection "${args.connectionId}" not found or not connected` }
      }

      let repoKind: 'git' | 'folder' = args.kind ?? 'git'
      let resolvedPath = args.remotePath

      // Why: `~` is a shell expansion that Node's fs APIs don't understand.
      // Resolve tilde paths to absolute paths via the relay before storing,
      // so all downstream fs operations (readDir, stat, etc.) work correctly.
      if (resolvedPath === '~' || resolvedPath === '~/' || resolvedPath.startsWith('~/')) {
        const mux = getActiveMultiplexer(args.connectionId)
        if (mux) {
          try {
            const result = (await mux.request('session.resolveHome', {
              path: resolvedPath
            })) as { resolvedPath: string }
            resolvedPath = result.resolvedPath
          } catch {
            // Relay may not support resolveHome yet — fall through to raw path
          }
        }
      }

      // Why: check for duplicates after tilde resolution so that adding `~/`
      // when `/home/ubuntu` is already stored correctly detects the duplicate.
      const existing = store
        .getRepos()
        .find((r) => r.connectionId === args.connectionId && r.path === resolvedPath)
      if (existing) {
        emitRepoAdded('folder_picker', true)
        return { repo: existing }
      }

      if (args.kind !== 'folder') {
        // Why: when kind is not explicitly 'folder', verify the remote path is
        // a git repo. Return an error on failure so the renderer can show the "Open as
        // Folder" confirmation dialog — matching the local add-repo behavior
        // where non-git directories require explicit user consent.
        try {
          const check = await gitProvider.isGitRepoAsync(resolvedPath)
          if (check.isRepo) {
            repoKind = 'git'
            if (check.rootPath) {
              resolvedPath = check.rootPath
            }
          } else {
            return { error: `Not a valid git repository: ${args.remotePath}` }
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('Not a valid git repository')) {
            return { error: err.message }
          }
          return { error: `Not a valid git repository: ${args.remotePath}` }
        }
      }

      const folderName = getRemoteRepoFolderName(resolvedPath)

      // When folderName is the home directory basename (e.g. 'ubuntu'),
      // use SSH target label for a more descriptive name
      let displayName = args.displayName || folderName
      if (!args.displayName && (args.remotePath === '~' || args.remotePath === '~/')) {
        const sshTarget = store.getSshTarget(args.connectionId)
        if (sshTarget) {
          displayName = sshTarget.label
        }
      }

      const repoIcon = await detectRepoIcon({
        repoPath: resolvedPath,
        kind: repoKind,
        connectionId: args.connectionId
      })
      const repo: Repo = {
        id: randomUUID(),
        path: resolvedPath,
        displayName,
        badgeColor: DEFAULT_REPO_BADGE_COLOR,
        ...(repoIcon ? { repoIcon } : {}),
        addedAt: Date.now(),
        kind: repoKind,
        connectionId: args.connectionId,
        ...(repoKind === 'git'
          ? {
              externalWorktreeVisibility: 'hide' as const,
              externalWorktreeVisibilityLegacy: false
            }
          : {})
      }

      store.addRepo(repo)
      notifyReposChanged(mainWindow)

      // Why: register the workspace root with the relay so mutating FS operations
      // are scoped to this repo's path. Without this, the relay's path ACL would
      // reject writes to the workspace after the first root is registered.
      const mux = getActiveMultiplexer(args.connectionId)
      if (mux) {
        mux.notify('session.registerRoot', { rootPath: resolvedPath })
      }

      emitRepoAdded('folder_picker', false)
      return { repo }
    }
  )

  // Creates a new repo or folder from scratch (orca#763). An empty initial
  // commit is required for git repos so HEAD has a branch ref — Orca's
  // worktree features all need one.
  ipcMain.handle(
    'repos:create',
    async (
      _event,
      args: { parentPath: string; name: string; kind: 'git' | 'folder' }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const name = args.name?.trim() ?? ''
      const parentPath = args.parentPath?.trim() ?? ''
      // Why: IPC input is untrusted — coerce to the narrow union so a bogus
      // string (e.g. "x") can't skip git init yet persist as kind: "x" in the
      // store. Mirrors the coercion in repos:add above.
      const repoKind: 'git' | 'folder' = args.kind === 'folder' ? 'folder' : 'git'

      if (!name) {
        return { error: 'Name cannot be empty' }
      }
      // Block slashes and ./.. so the name can't escape the chosen parent.
      // The UI already disables submit in these cases; this guards direct IPC use.
      if (/[\\/]/.test(name) || name === '.' || name === '..') {
        return { error: 'Name cannot contain slashes or be "." / ".."' }
      }
      if (!parentPath) {
        return { error: 'Parent directory is required' }
      }
      // Why: blocks CWD-relative paths from slipping through the IPC boundary;
      // the UI uses pickDirectory which returns absolute paths, this guards
      // direct IPC use (and keeps targetPath stable across process cwd changes).
      if (!isAbsolute(parentPath)) {
        return { error: 'Parent directory must be an absolute path' }
      }

      const targetPath = join(parentPath, name)

      // Dedup by path (same as repos:add) so a double-click on Create doesn't
      // produce two sidebar entries pointing at the same folder. This is the
      // first of three dedup checks; see the pre-addRepo check below for why
      // the race matters even after this one passes.
      const existing = store.getRepos().find((r) => r.path === targetPath)
      if (existing) {
        emitRepoAdded('folder_picker', true)
        return { repo: existing }
      }

      // Empty pre-existing directories are allowed (e.g. one the user made in
      // Finder first). Non-empty ones are rejected so we don't overwrite files.
      let createdDir = false
      let targetExists = false
      try {
        await access(targetPath)
        targetExists = true
      } catch (err) {
        // Why: only ENOENT means "the path is free to use". Other codes
        // (EACCES, ENOTDIR, EPERM, ELOOP, ...) mean something is in the way
        // that mkdir can't fix — surface a precise error instead of falling
        // through to mkdir and returning a misleading "Failed to create
        // directory" message.
        //
        // Why the message fallback: fs.promises.access always attaches a
        // NodeJS.ErrnoException code in production, but plain Error objects
        // thrown in tests / non-Node contexts won't — treat a message that
        // reads like ENOENT as one so we don't over-reject.
        const code =
          err && typeof err === 'object' && 'code' in err
            ? (err as NodeJS.ErrnoException).code
            : undefined
        const looksLikeEnoent =
          code === 'ENOENT' ||
          (code === undefined && err instanceof Error && /ENOENT/.test(err.message))
        if (!looksLikeEnoent) {
          const message = err instanceof Error ? err.message : String(err)
          return { error: `Cannot access target path: ${message}` }
        }
      }

      if (targetExists) {
        try {
          const entries = await readdir(targetPath)
          if (entries.length > 0) {
            return {
              error: `"${name}" already exists at this location and is not empty.`
            }
          }
        } catch (err) {
          // Why: access succeeded but readdir failed — the path exists but we
          // can't inspect it (e.g. it's a file, not a directory; or perms).
          // mkdir would definitely fail here too, so return a distinct error.
          const message = err instanceof Error ? err.message : String(err)
          return { error: `Failed to read directory: ${message}` }
        }
      } else {
        try {
          await mkdir(targetPath, { recursive: false })
          createdDir = true
        } catch (err) {
          // Why: EEXIST here means another concurrent repos:create for the
          // same path won the mkdir race. If they already added the repo to
          // the store, return that entry instead of a confusing error. This
          // is the second dedup check; see the pre-addRepo check below for
          // the full race explanation.
          const code =
            err && typeof err === 'object' && 'code' in err
              ? (err as NodeJS.ErrnoException).code
              : undefined
          const isEexist = code === 'EEXIST' || (err instanceof Error && /EEXIST/.test(err.message))
          if (isEexist) {
            const raceWinner = store.getRepos().find((r) => r.path === targetPath)
            if (raceWinner) {
              return { repo: raceWinner }
            }
          }
          const message = err instanceof Error ? err.message : String(err)
          return { error: `Failed to create directory: ${message}` }
        }
      }

      if (repoKind === 'git') {
        // Why: track which git step is running so the catch can attribute the
        // failure correctly. The identity-hint regex is only meaningful during
        // commit — git init itself never produces "Please tell me who you are".
        let step: 'init' | 'commit' = 'init'
        try {
          await gitExecFileAsync(['init'], { cwd: targetPath })
          step = 'commit'
          await gitExecFileAsync(['commit', '--allow-empty', '-m', 'Initial commit'], {
            cwd: targetPath
          })
        } catch (err) {
          // Only remove the directory if we made it. A pre-existing folder the
          // user picked must survive so they can retry after fixing git config.
          // Why: if we didn't make the directory but `git init` created `.git/`
          // inside it, strip just `.git/` so the user's folder looks the way
          // they left it. Retrying works either way, but leaving a half-init'd
          // repo behind is confusing if they choose to skip the retry.
          if (createdDir) {
            await rm(targetPath, { recursive: true, force: true }).catch(() => {})
          } else if (step === 'commit') {
            await rm(join(targetPath, '.git'), { recursive: true, force: true }).catch(() => {})
          }
          const message = err instanceof Error ? err.message : String(err)
          if (
            step === 'commit' &&
            /Please tell me who you are|user\.name|user\.email/i.test(message)
          ) {
            return {
              error:
                'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.'
            }
          }
          const stepLabel =
            step === 'init'
              ? 'Failed to initialize git repository'
              : 'Failed to create initial commit'
          return { error: `${stepLabel}: ${message}` }
        }
      }

      // Why: ipcMain.handle doesn't serialize concurrent calls; re-running the
      // dedup lookup here closes the window between the first check and
      // addRepo. A second repos:create for the same path that raced past the
      // initial dedup now returns the entry the first call persisted.
      const raceWinner = store.getRepos().find((r) => r.path === targetPath)
      if (raceWinner) {
        // Why: do NOT rm even if this invocation created the directory — the
        // other invocation is using it. Leaking a freshly-made empty folder on
        // a rare race is strictly safer than deleting a directory the winning
        // call (and the user) now owns.
        emitRepoAdded('folder_picker', true)
        return { repo: raceWinner }
      }

      const repoIcon = await detectRepoIcon({ repoPath: targetPath, kind: repoKind })
      const repo: Repo = {
        id: randomUUID(),
        path: targetPath,
        displayName: name,
        badgeColor: DEFAULT_REPO_BADGE_COLOR,
        ...(repoIcon ? { repoIcon } : {}),
        addedAt: Date.now(),
        kind: repoKind,
        ...(repoKind === 'git'
          ? {
              externalWorktreeVisibility: 'hide' as const,
              externalWorktreeVisibilityLegacy: false
            }
          : {})
      }

      store.addRepo(repo)
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', false)
      return { repo }
    }
  )

  ipcMain.handle(
    'repos:reorder',
    (_event, args: { orderedIds: string[] }): { status: 'applied' | 'rejected' } => {
      // Why: validate at the IPC boundary — IPC input is untrusted and a
      // permutation mismatch means the renderer's drag was stale relative to
      // a concurrent add/remove. Reject so the renderer can resync.
      const ids = Array.isArray(args?.orderedIds) ? args.orderedIds : []
      const applied = store.reorderRepos(ids)
      if (applied) {
        notifyReposChanged(mainWindow)
        return { status: 'applied' }
      }
      return { status: 'rejected' }
    }
  )

  ipcMain.handle('repos:remove', async (_event, args: { repoId: string }) => {
    store.removeProject(args.repoId)
    invalidateAuthorizedRootsCache()
    notifyReposChanged(mainWindow)
  })

  ipcMain.handle(
    'repos:update',
    (
      _event,
      args: {
        repoId: string
        updates: Partial<
          Pick<
            Repo,
            | 'displayName'
            | 'badgeColor'
            | 'repoIcon'
            | 'hookSettings'
            | 'worktreeBaseRef'
            | 'worktreeBasePath'
            | 'kind'
            | 'symlinkPaths'
            | 'issueSourcePreference'
            | 'externalWorktreeVisibility'
            | 'externalWorktreeVisibilityPromptDismissedAt'
            | 'projectGroupId'
            | 'projectGroupOrder'
            | 'sourceControlAi'
          >
        >
      }
    ) => {
      // Why: validate the persisted preference string at the IPC boundary
      // — the TypeScript signature is erased at runtime, and a preload
      // version skew or renderer bug could otherwise persist a garbage
      // string that silently collapses to 'auto' in `resolveIssueSource`
      // (see gh-utils.ts#resolveIssueSource). Strip rather than throw so
      // other valid fields in the same call still persist.
      const updates = { ...args.updates }
      if (
        'issueSourcePreference' in updates &&
        updates.issueSourcePreference !== undefined &&
        updates.issueSourcePreference !== 'upstream' &&
        updates.issueSourcePreference !== 'origin' &&
        updates.issueSourcePreference !== 'auto'
      ) {
        delete updates.issueSourcePreference
      }
      // Why: `symlinkPaths` is consumed by `createWorktreeSymlinks` which
      // calls `.trim()` on each entry. A renderer bug or preload-version skew
      // that persists a non-`string[]` value (e.g. `[42, null]`, a bare
      // string) would throw inside the worktree-create path with no UI
      // signal. Strip invalid shapes at the boundary the same way
      // `issueSourcePreference` is validated above.
      if ('symlinkPaths' in updates && updates.symlinkPaths !== undefined) {
        const v = updates.symlinkPaths as unknown
        if (!Array.isArray(v) || !v.every((e) => typeof e === 'string')) {
          delete updates.symlinkPaths
        }
      }
      if ('worktreeBasePath' in updates && updates.worktreeBasePath !== undefined) {
        const v = updates.worktreeBasePath as unknown
        if (typeof v !== 'string') {
          delete updates.worktreeBasePath
        } else {
          updates.worktreeBasePath = v.trim() || undefined
        }
      }
      if ('repoIcon' in updates) {
        const repoIcon = sanitizeRepoIcon(updates.repoIcon)
        if (repoIcon === undefined) {
          delete updates.repoIcon
        } else {
          updates.repoIcon = repoIcon
        }
      }
      if ('badgeColor' in updates) {
        const badgeColor = normalizeRepoBadgeColor(updates.badgeColor)
        if (!badgeColor) {
          delete updates.badgeColor
        } else {
          updates.badgeColor = badgeColor
        }
      }
      if (
        'externalWorktreeVisibility' in updates &&
        updates.externalWorktreeVisibility !== undefined &&
        updates.externalWorktreeVisibility !== 'hide' &&
        updates.externalWorktreeVisibility !== 'show'
      ) {
        delete updates.externalWorktreeVisibility
      }
      if (
        'externalWorktreeVisibilityPromptDismissedAt' in updates &&
        updates.externalWorktreeVisibilityPromptDismissedAt !== undefined &&
        (typeof updates.externalWorktreeVisibilityPromptDismissedAt !== 'number' ||
          !Number.isFinite(updates.externalWorktreeVisibilityPromptDismissedAt))
      ) {
        delete updates.externalWorktreeVisibilityPromptDismissedAt
      }
      if ('sourceControlAi' in updates && updates.sourceControlAi !== undefined) {
        const normalizedSourceControlAi = normalizeRepoSourceControlAiOverrides(
          updates.sourceControlAi
        )
        if (normalizedSourceControlAi === undefined) {
          delete updates.sourceControlAi
        } else {
          updates.sourceControlAi = normalizedSourceControlAi
        }
      }
      const updated = store.updateRepo(args.repoId, updates)
      if (updated) {
        if ('worktreeBasePath' in updates) {
          invalidateAuthorizedRootsCache()
        }
        notifyReposChanged(mainWindow)
      }
      return updated
    }
  )

  // ── Sparse presets ─────────────────────────────────────────────
  // Why: presets are repo-scoped reusable directory lists used by the
  // new-workspace composer. Persisted via Store and broadcast back to the
  // renderer so any open composer reflects new/edited/deleted presets
  // immediately.

  ipcMain.handle('sparsePresets:list', (_event, args: { repoId: string }) => {
    return store.getSparsePresets(args.repoId)
  })

  ipcMain.handle(
    'sparsePresets:save',
    (
      _event,
      args: { repoId: string; id?: string; name: string; directories: string[] }
    ): SparsePreset => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo "${args.repoId}" not found`)
      }
      const name = normalizeSparsePresetName(args.name)
      const directories = normalizeSparsePresetDirectories(args.directories)
      const now = Date.now()
      const existing = args.id
        ? store.getSparsePresets(args.repoId).find((preset) => preset.id === args.id)
        : undefined
      const preset: SparsePreset = {
        id: existing?.id ?? randomUUID(),
        repoId: args.repoId,
        name,
        directories,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      const saved = store.saveSparsePreset(preset)
      notifySparsePresetsChanged(mainWindow, args.repoId)
      return saved
    }
  )

  ipcMain.handle('sparsePresets:remove', (_event, args: { repoId: string; presetId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      throw new Error(`Repo "${args.repoId}" not found`)
    }
    store.removeSparsePreset(args.repoId, args.presetId)
    notifySparsePresetsChanged(mainWindow, args.repoId)
  })

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
  // pickFolder which is specifically the "add project" flow. Clone needs a
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
    if (activeClone) {
      const clone = activeClone
      clone.abortRequested = true
      markCloneAbortCleanupPending(clone)
      clone.process.kill()
      activeClone = null
    }
  })

  ipcMain.handle(
    'repos:clone',
    async (_event, args: { url: string; destination: string }): Promise<Repo> => {
      // Why: the user picks a parent directory (e.g. ~/projects) and we derive
      // the repo folder name from the URL (e.g. "orca" from .../orca.git).
      // This matches the default git clone behavior where the last path segment
      // of the URL becomes the directory name.
      const clonePath = deriveValidatedClonePath(args)
      const clonePathKey = getClonePathComparisonKey(clonePath)
      return runWithClonePathLock(clonePathKey, async () => {
        await pendingAbortCleanupByPath.get(clonePathKey)
        const existingAfterPendingClone = store
          .getRepos()
          .find((r) => getClonePathComparisonKey(r.path) === clonePathKey)
        if (existingAfterPendingClone && !isFolderRepo(existingAfterPendingClone)) {
          emitRepoAdded('clone_url', true)
          return existingAfterPendingClone
        }
        // Why: gitSpawn uses args.destination as cwd, so it must exist before
        // spawn — fresh installs may have a defaulted parent dir that does not
        // exist yet (e.g. ~/orca). recursive: true is a no-op when present.
        await mkdir(args.destination, { recursive: true })
        const claimedTarget = await claimCloneTarget(clonePath)

        // Why: use spawn instead of execFile so there is no maxBuffer limit.
        // git clone writes progress to stderr which can exceed Node's default
        // 1 MB buffer on large or submodule-heavy repos. We only keep the tail
        // of stderr for error reporting and discard stdout entirely.
        // Why: use --progress to force git to emit progress even when stderr
        // is not a TTY. Without it, git suppresses progress output when piped.
        const cloneMetadataRef: { current: ActiveCloneMetadata | null } = { current: null }
        await new Promise<void>((resolve, reject) => {
          // Why: clone destination may be a WSL path (e.g. user picks a WSL
          // directory). Use the parent destination as the cwd so the runner
          // detects WSL and routes through wsl.exe.
          // Why: use the '--' separator to isolate the URL argument and prevent
          // malicious URLs from being interpreted as git flags (command injection).
          let proc: ReturnType<typeof gitSpawn>
          try {
            proc = gitSpawn(['clone', '--progress', '--', args.url, clonePath], {
              cwd: args.destination,
              stdio: ['ignore', 'ignore', 'pipe']
            })
          } catch (err) {
            void cleanupClaimedCloneTarget(clonePath, claimedTarget).finally(() => {
              const message = err instanceof Error ? err.message : String(err)
              reject(new Error(`Clone failed: ${message}`))
            })
            return
          }
          const generation = nextCloneGeneration++
          latestCloneGenerationByPath.set(clonePathKey, generation)
          const metadata: ActiveCloneMetadata = {
            path: clonePath,
            pathKey: clonePathKey,
            claimedTarget,
            process: proc,
            abortRequested: false,
            generation,
            pendingAbortCleanup: null,
            resolvePendingAbortCleanup: null
          }
          cloneMetadataRef.current = metadata
          activeClone = metadata

          let stderrTail = ''
          let settled = false
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

          const finishClone = async (
            code: number | null,
            signal: NodeJS.Signals | null,
            err?: Error
          ) => {
            if (settled) {
              return
            }
            settled = true
            // Why: only clear the ref if it still points to this process.
            // A quick abort-and-retry can reassign activeClone to a new
            // spawn before this handler fires, and nulling it would make the
            // new clone unabortable.
            if (activeClone?.process === proc) {
              activeClone = null
            }

            const cloneSucceeded = !err && code === 0 && !signal
            if (!cloneSucceeded) {
              // Why: only the process that created this target may remove it,
              // and only after git reports the clone did not complete.
              await cleanupOwnedCloneTarget(metadata)
            }
            if (metadata.abortRequested && !cloneSucceeded) {
              settleCloneAbortCleanup(metadata)
            }
            if (latestCloneGenerationByPath.get(metadata.pathKey) === metadata.generation) {
              latestCloneGenerationByPath.delete(metadata.pathKey)
            }

            if (err) {
              reject(new Error(`Clone failed: ${err.message}`))
            } else if (signal === 'SIGTERM') {
              reject(new Error('Clone aborted'))
            } else if (code === 0) {
              resolve()
            } else {
              const lastLine = stderrTail.trim().split('\n').pop() ?? 'unknown error'
              reject(new Error(`Clone failed: ${lastLine}`))
            }
          }

          proc.on('error', (err) => {
            void finishClone(null, null, err)
          })

          proc.on('close', (code, signal) => {
            void finishClone(code, signal)
          })
        })

        try {
          // Why: check after clone (not before) because the path didn't exist
          // before cloning. But if the user somehow had a folder repo at this path
          // that git clone succeeded into (empty dir), reuse that entry and upgrade
          // its kind to 'git' instead of creating a duplicate.
          const existing = store
            .getRepos()
            .find((r) => getClonePathComparisonKey(r.path) === clonePathKey)
          if (existing) {
            if (isFolderRepo(existing)) {
              const updated = store.updateRepo(existing.id, { kind: 'git' })
              if (updated) {
                notifyReposChanged(mainWindow)
                // Why: folder→git upgrade is a real new git repo provisioning event.
                emitRepoAdded('clone_url', false)
                return updated
              }
            }
            emitRepoAdded('clone_url', true)
            return existing
          }

          const repoIcon = await detectRepoIcon({ repoPath: clonePath, kind: 'git' })
          const repo: Repo = {
            id: randomUUID(),
            path: clonePath,
            displayName: getRepoName(clonePath),
            badgeColor: DEFAULT_REPO_BADGE_COLOR,
            ...(repoIcon ? { repoIcon } : {}),
            addedAt: Date.now(),
            kind: 'git',
            externalWorktreeVisibility: 'hide',
            externalWorktreeVisibilityLegacy: false
          }

          store.addRepo(repo)
          invalidateAuthorizedRootsCache()
          notifyReposChanged(mainWindow)
          emitRepoAdded('clone_url', false)
          return repo
        } finally {
          const metadata = cloneMetadataRef.current
          if (metadata?.abortRequested) {
            settleCloneAbortCleanup(metadata)
          }
        }
      })
    }
  )

  ipcMain.handle('repos:getGitUsername', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return ''
    }
    // Why: remote repos have their git config on the remote host. Keep this
    // to explicit username config; user.email/name are author identity.
    if (repo.connectionId) {
      const provider = getSshGitProvider(repo.connectionId)
      if (!provider) {
        return ''
      }
      return getSshGitUsername(provider, repo.path)
    }
    return getGitUsername(repo.path)
  })

  ipcMain.handle(
    'repos:getBaseRefDefault',
    async (_event, args: { repoId: string }): Promise<BaseRefDefaultResult> => {
      const repo = store.getRepo(args.repoId)
      if (!repo || isFolderRepo(repo)) {
        // Why: folder-mode repos have no git state to resolve a base ref from.
        // Return null + 0 so the renderer can decline to use a fabricated default
        // and suppress the multi-remote hint.
        return { defaultBaseRef: null, remoteCount: 0 }
      }
      // Why: remote repos need the relay to resolve symbolic-ref on the
      // remote host where the git data lives.
      if (repo.connectionId) {
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          return { defaultBaseRef: null, remoteCount: 0 }
        }
        // Why: run default-ref resolution and remote-count concurrently to
        // match the local path's latency characteristics (see Promise.all
        // below). The two lookups are independent — neither depends on the
        // other's result — so serializing them only adds SSH round-trip
        // latency on slow relays.
        //
        // Why: delegate to the shared resolveDefaultBaseRefViaExec so SSH and
        // local repos return identical defaults for equivalent states. We
        // log in the exec callback for the symbolic-ref call to preserve the
        // SSH-specific transport-failure diagnostic (connection drops,
        // permission issues) that the shared helper otherwise swallows
        // together with the expected "origin/HEAD unset" non-zero exit.
        const resolveDefault = async (): Promise<string | null> => {
          return resolveDefaultBaseRefViaExec(async (argv) => {
            try {
              return await provider.exec(argv, repo.path)
            } catch (err) {
              if (argv[0] === 'symbolic-ref') {
                console.warn('[repos:getBaseRefDefault] SSH symbolic-ref failed', {
                  path: repo.path,
                  err
                })
              }
              throw err
            }
          })
        }

        const resolveRemoteCount = async (): Promise<number> => {
          try {
            const remotesResult = await provider.exec(['remote'], repo.path)
            return parseRemoteCount(remotesResult.stdout)
          } catch (err) {
            // Why: fall back to 0 (the "unknown / do not render the multi-remote
            // hint" sentinel). Log so diagnostic signal isn't lost.
            console.warn('[repos:getBaseRefDefault] SSH git remote count failed', {
              path: repo.path,
              err
            })
            return 0
          }
        }

        const [defaultBaseRef, remoteCount] = await Promise.all([
          resolveDefault(),
          resolveRemoteCount()
        ])
        return { defaultBaseRef, remoteCount }
      }
      // Why: compute default and remote count independently. A failure
      // counting remotes must not break default detection. Run in parallel
      // since the two lookups don't depend on each other.
      const [defaultBaseRef, remoteCount] = await Promise.all([
        getBaseRefDefault(repo.path),
        getRemoteCount(repo.path)
      ])
      return { defaultBaseRef, remoteCount }
    }
  )

  ipcMain.handle(
    'repos:searchBaseRefs',
    async (_event, args: { repoId: string; query: string; limit?: number }) => {
      return (await searchBaseRefDetailsForRepo(store, args)).map((entry) => entry.refName)
    }
  )

  ipcMain.handle(
    'repos:searchBaseRefDetails',
    async (_event, args: { repoId: string; query: string; limit?: number }) => {
      return searchBaseRefDetailsForRepo(store, args)
    }
  )
}

async function searchBaseRefDetailsForRepo(
  store: Store,
  args: { repoId: string; query: string; limit?: number }
): Promise<BaseRefSearchResult[]> {
  const repo = store.getRepo(args.repoId)
  if (!repo || isFolderRepo(repo)) {
    return []
  }
  const limit = args.limit ?? 25
  if (!Number.isInteger(limit) || limit <= 0) {
    return []
  }
  // Why: remote repos need the relay to list branches on the remote host.
  if (repo.connectionId) {
    const provider = getSshGitProvider(repo.connectionId)
    if (!provider) {
      return []
    }
    // Why: mirror the local path's sanitization (normalizeRefSearchQuery
    // in ../git/repo.ts) — strip glob metacharacters to prevent glob
    // injection via the SSH branch while preserving empty-query branch lists.
    const normalizedQuery = normalizeRefSearchQuery(args.query)
    try {
      // Why: argv (including the two-remote-glob rationale) lives in
      // buildSearchBaseRefsArgv so the SSH and local paths cannot drift.
      const remotesPromise = provider.exec(['remote'], repo.path).catch(() => ({ stdout: '' }))
      let result: { stdout: string }
      try {
        result = await provider.exec(buildSearchBaseRefsArgv(normalizedQuery, limit), repo.path)
      } catch (err) {
        if (!isForEachRefExcludeUnsupportedError(err)) {
          throw err
        }
        result = await provider.exec(
          buildSearchBaseRefsArgv(normalizedQuery, limit, { excludeRemoteHead: false }),
          repo.path
        )
      }
      const remotesResult = await remotesPromise
      // Why: delegate the NUL-parse + HEAD filter + dedup + limit pipeline
      // to the shared helper so the SSH and local paths cannot diverge.
      // See parseAndFilterSearchRefs in ../git/repo.ts for the dedup +
      // HEAD-filter rationale.
      const remotes = remotesResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      return parseAndFilterSearchRefDetails(result.stdout, limit, remotes)
    } catch (err) {
      console.warn('[repos:searchBaseRefs] SSH for-each-ref failed', {
        path: repo.path,
        err
      })
      return []
    }
  }
  return searchBaseRefDetails(repo.path, args.query, limit)
}

function notifyReposChanged(mainWindow: BrowserWindow): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('repos:changed')
  }
}

function notifySparsePresetsChanged(mainWindow: BrowserWindow, repoId: string): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sparsePresets:changed', { repoId })
  }
}

function normalizeSparsePresetName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Preset name is required.')
  }
  if (trimmed.length > 80) {
    throw new Error('Preset name is too long.')
  }
  return trimmed
}

function normalizeSparsePresetDirectories(directories: string[]): string[] {
  let normalized: string[]
  try {
    normalized = normalizeSparseDirectories(directories)
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === 'Sparse checkout directories must be repo-relative paths.'
    ) {
      throw new Error('Preset directories must be repo-relative paths.')
    }
    throw err
  }
  if (normalized.length === 0) {
    throw new Error('Preset must have at least one directory.')
  }
  return normalized
}
