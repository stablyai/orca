/* eslint-disable max-lines -- Why: repo IPC is centralized so SSH routing, clone lifecycle, and store persistence stay behind one audited boundary. */
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { z } from 'zod'
import type { Store } from '../persistence'
import type {
  BaseRefSearchResult,
  Project,
  Repo,
  ProjectGroup,
  FolderWorkspace,
  ProjectGroupImportResult,
  ProjectUpdateArgs,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  NestedRepoScanResult,
  BaseRefDefaultResult,
  SparsePreset
} from '../../shared/types'
import type { FolderWorkspacePathStatusRequest } from '../../shared/folder-workspace-path-status'
import { isFolderRepo } from '../../shared/repo-kind'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { normalizeRepoBadgeColor } from '../../shared/repo-badge-color'
import { sanitizeRepoIcon } from '../../shared/repo-icon'
import { normalizeRepoSourceControlAiOverrides } from '../../shared/source-control-ai'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { invalidateAuthorizedRootsCache } from './filesystem-auth'
import type { ChildProcess } from 'node:child_process'
import { access, mkdir, readdir, rm } from 'node:fs/promises'
import { gitExecFileAsync, gitSpawn, nonInteractiveGitEnv } from '../git/runner'
import { isAbsolute, join, posix } from 'node:path'
import {
  cleanupClaimedCloneTarget,
  claimCloneTarget,
  deriveCloneRepoNameFromUrl,
  deriveValidatedClonePath,
  getClonePathComparisonKey
} from '../git/repo-clone-path'
import type { ClaimedCloneTarget } from '../git/repo-clone-path'
import { scanNestedRepos } from '../project-groups/nested-repo-discovery'
import {
  createNestedProjectGroupResolver,
  resolveNestedRepoSelection
} from '../project-groups/nested-repo-import'
import { createNestedRepoImportTargetResolver } from '../project-groups/nested-repo-import-target'
import {
  isGitRepo,
  getGitRepoRoot,
  getRepoName,
  getBaseRefDefault,
  getRemoteCount,
  normalizeRefSearchQuery,
  parseAndFilterSearchRefDetails,
  parseRemoteCount,
  resolveDefaultBaseRefViaExec,
  buildSearchBaseRefsArgv,
  isForEachRefExcludeUnsupportedError,
  mergeBaseRefSearchResultGroups,
  searchBaseRefDetails
} from '../git/repo'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshGitCapabilityCache } from '../git/git-capability-state'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSshGitUsername, resolveLocalGitUsername } from '../git/git-username'
import { enrichRepoGitUsernames } from '../repo-git-username-enrichment'
import { getActiveMultiplexer } from './ssh'
import { normalizeSparseDirectories } from './sparse-checkout-directories'
import { track } from '../telemetry/client'
import { scheduleCurrentWorktreeBaseDirectoryWatcherSync } from './worktree-base-directory-watcher'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import type { RepoMethod } from '../../shared/telemetry-events'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import { enrichMissingRepoGitRemoteIdentities } from '../repo-git-remote-identity-enrichment'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-projection'
import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus,
  getFolderWorkspacePathStatusForPath
} from '../project-groups/folder-workspace-path-status'
import { getGitCloneFailureMessage } from '../../shared/git-clone-failure-message'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import { runWithGitReadCacheInvalidation } from '../git/status'

// Why: `method` is the IPC entry point the user took, not what they added (never path/URL/name); repos:create → 'folder_picker'.
// Why: `isGitRepo` is a non-identifying git-vs-folder signal from the caller's detection; pass undefined when unknown, never default false.
// Why: it replaced onboarding_completed.is_git_repo, which lost meaning once repo selection left onboarding (1.4.46).
function emitRepoAdded(method: RepoMethod, alreadyExisted: boolean, isGitRepo?: boolean): void {
  // Why: re-adding an existing repo isn't a new activation; suppress so re-picking a folder doesn't inflate repo_added.
  if (alreadyExisted) {
    return
  }
  // Why: read cohort AFTER store.addRepo() so the just-added repo is counted (docs/onboarding-funnel-cohort-addendum.md §Read-vs-write ordering).
  const props = {
    method,
    ...(isGitRepo === undefined ? {} : { is_git_repo: isGitRepo }),
    ...getCohortAtEmit()
  }
  track('repo_added', props)
}

function buildProjectHostSetupResult(store: Store, repo: Repo): ProjectHostSetupResult {
  const setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  const project = store.getProjects().find((entry) => entry.id === setup.projectId)
  if (!project) {
    throw new Error(`Project setup was created without a project record: ${setup.projectId}`)
  }
  return { project, setup, repo }
}

function alignRepoWithRequestedProject(
  store: Store,
  repo: Repo,
  projectId: string,
  setupMethod: ProjectHostSetupExistingFolderArgs['setupMethod'] = 'imported-existing-folder'
): ProjectHostSetupResult {
  let setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  if (setup.projectId !== projectId) {
    const project = store.getProjects().find((entry) => entry.id === projectId)
    if (!project?.providerIdentity || project.providerIdentity.provider !== 'github') {
      throw new Error('Imported folder does not match the selected project identity.')
    }
    // Why: stamp the selected project's provider identity when the folder lacks upstream, so projection can merge it.
    const updated = store.updateRepo(repo.id, {
      upstream: {
        owner: project.providerIdentity.owner,
        repo: project.providerIdentity.repo,
        ...(project.providerIdentity.host ? { host: project.providerIdentity.host } : {})
      }
    })
    if (!updated) {
      throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
    }
    repo = updated
    setup = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo)
  }
  const updated = store.updateRepo(repo.id, { projectHostSetupMethod: setupMethod })
  if (!updated) {
    throw new Error(
      `Project setup repo disappeared before setup metadata could be linked: ${repo.id}`
    )
  }
  repo = updated
  return buildProjectHostSetupResult(store, repo)
}

async function addLocalRepoFromPath(
  store: Store,
  path: string,
  kind: 'git' | 'folder' = 'git'
): Promise<{ repo: Repo; alreadyExisted: boolean } | { error: string }> {
  const repoKind = kind === 'folder' ? 'folder' : 'git'
  if (repoKind === 'git' && !isGitRepo(path)) {
    return { error: `Not a valid git repository: ${path}` }
  }

  const resolvedPath = repoKind === 'git' ? getGitRepoRoot(path) : path
  const pathKey = normalizeRuntimePathForComparison(path)
  const existing = store
    .getRepos()
    .find((repo) => !repo.connectionId && normalizeRuntimePathForComparison(repo.path) === pathKey)
  if (existing) {
    return { repo: existing, alreadyExisted: true }
  }

  const resolvedPathKey = normalizeRuntimePathForComparison(resolvedPath)
  if (resolvedPathKey !== pathKey) {
    const existingAfterRootResolve = store
      .getRepos()
      .find(
        (repo) =>
          !repo.connectionId && normalizeRuntimePathForComparison(repo.path) === resolvedPathKey
      )
    if (existingAfterRootResolve) {
      return { repo: existingAfterRootResolve, alreadyExisted: true }
    }
  }

  const detected = await detectRepoIconAndUpstream({ repoPath: resolvedPath, kind: repoKind })
  const repo: Repo = {
    id: randomUUID(),
    path: resolvedPath,
    displayName: getRepoName(resolvedPath),
    badgeColor: DEFAULT_REPO_BADGE_COLOR,
    ...detected,
    addedAt: Date.now(),
    kind: repoKind,
    ...(repoKind === 'git'
      ? {
          externalWorktreeVisibility: 'hide' as const,
          externalWorktreeVisibilityLegacy: false,
          // Why: new Add Project imports are explicit ready host setups; 'legacy-repo' is reserved for older records/projection.
          projectHostSetupMethod: 'imported-existing-folder' as const
        }
      : {})
  }

  store.addRepo(repo)
  await prepareLocalWorktreeRootForRepo(store, repo)
  return { repo, alreadyExisted: false }
}

async function addRemoteRepoFromPath(
  store: Store,
  args: {
    connectionId: string
    remotePath: string
    displayName?: string
    kind?: 'git' | 'folder'
    setupMethod?: Repo['projectHostSetupMethod']
  }
): Promise<{ repo: Repo; alreadyExisted: boolean } | { error: string }> {
  const gitProvider = getSshGitProvider(args.connectionId)
  if (!gitProvider) {
    return { error: `SSH connection "${args.connectionId}" not found or not connected` }
  }

  let repoKind: 'git' | 'folder' = args.kind ?? 'git'
  let resolvedPath = await resolveRemoteHomePath(args.connectionId, args.remotePath)

  const existing = store
    .getRepos()
    .find(
      (repo) =>
        repo.connectionId === args.connectionId &&
        normalizeRuntimePathForComparison(repo.path) ===
          normalizeRuntimePathForComparison(resolvedPath)
    )
  if (existing) {
    return { repo: existing, alreadyExisted: true }
  }

  if (args.kind !== 'folder') {
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

  const existingAfterRootResolve = store
    .getRepos()
    .find(
      (repo) =>
        repo.connectionId === args.connectionId &&
        normalizeRuntimePathForComparison(repo.path) ===
          normalizeRuntimePathForComparison(resolvedPath)
    )
  if (existingAfterRootResolve) {
    return { repo: existingAfterRootResolve, alreadyExisted: true }
  }

  const folderName = getRemoteRepoFolderName(resolvedPath)
  let displayName = args.displayName || folderName
  if (!args.displayName && (args.remotePath === '~' || args.remotePath === '~/')) {
    const sshTarget = store.getSshTarget(args.connectionId)
    if (sshTarget) {
      displayName = sshTarget.label
    }
  }

  const detected = await detectRepoIconAndUpstream({
    repoPath: resolvedPath,
    kind: repoKind,
    connectionId: args.connectionId
  })
  const repo: Repo = {
    id: randomUUID(),
    path: resolvedPath,
    displayName,
    badgeColor: DEFAULT_REPO_BADGE_COLOR,
    ...detected,
    addedAt: Date.now(),
    kind: repoKind,
    connectionId: args.connectionId,
    ...(repoKind === 'git'
      ? {
          externalWorktreeVisibility: 'hide' as const,
          externalWorktreeVisibilityLegacy: false,
          projectHostSetupMethod: args.setupMethod ?? ('imported-existing-folder' as const)
        }
      : {})
  }

  store.addRepo(repo)
  const mux = getActiveMultiplexer(args.connectionId)
  if (mux) {
    mux.notify('session.registerRoot', { rootPath: resolvedPath })
  }

  return { repo, alreadyExisted: false }
}

function getRemoteRepoFolderName(remotePath: string): string {
  const trimmed = remotePath.replace(/[\\/]+$/, '')
  if (!trimmed) {
    return remotePath
  }
  return trimmed.split(/[\\/]/).at(-1) || remotePath
}

async function cloneRemoteRepo(
  store: Store,
  mainWindow: BrowserWindow,
  args: {
    connectionId: string
    url: string
    destination: string
  }
): Promise<Repo> {
  const gitProvider = getSshGitProvider(args.connectionId)
  if (!gitProvider) {
    throw new Error(`SSH connection "${args.connectionId}" not found or not connected`)
  }
  const fsProvider = getSshFilesystemProvider(args.connectionId)
  if (!fsProvider) {
    throw new Error(`SSH connection "${args.connectionId}" not found or not connected`)
  }
  const host = gitProvider.getHostPlatform?.()
  if (!host) {
    throw new Error('SSH host platform is unavailable. Reconnect the SSH target before cloning.')
  }
  const trimmedDestination = await resolveRemoteHomePath(args.connectionId, args.destination.trim())
  if (!isRuntimePathAbsolute(trimmedDestination, host.pathFlavor)) {
    throw new Error('Clone destination must be an absolute path on the SSH host')
  }
  const repoName = deriveCloneRepoNameFromUrl(args.url.trim())
  const clonePath = joinRemotePath(host, trimmedDestination, repoName)
  if (relativePathInsideRoot(trimmedDestination, clonePath) === null) {
    throw new Error('Clone path must be inside the destination directory')
  }
  const clonePathKey = normalizeRuntimePathForComparison(clonePath)
  const existing = store.getRepos().find((repo) => {
    return (
      repo.connectionId === args.connectionId &&
      normalizeRuntimePathForComparison(repo.path) === clonePathKey
    )
  })
  if (existing && !isFolderRepo(existing)) {
    emitRepoAdded('clone_url', true)
    return existing
  }

  const remoteCloneKey = `${args.connectionId}:${clonePathKey}`
  if (remoteCloneInFlightByPath.has(remoteCloneKey)) {
    throw new Error('A clone is already in progress for this SSH destination')
  }
  const controller = new AbortController()
  const metadata: ActiveRemoteCloneMetadata = {
    connectionId: args.connectionId,
    clonePath,
    controller
  }
  activeRemoteClone = metadata
  remoteCloneInFlightByPath.add(remoteCloneKey)
  try {
    // Why: match local clone by creating the parent first, or a fresh remote parent surfaces as spawn ENOENT.
    await fsProvider.createDir(trimmedDestination)
    // Why: the SSH relay runs git argv, not a shell; use the repo folder name so git creates it under the chosen parent.
    await gitProvider.clone(
      ['clone', '--progress', '--', args.url.trim(), repoName],
      trimmedDestination,
      {
        signal: controller.signal,
        timeoutMs: 10 * 60_000,
        onProgress: (progress) => {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('repos:clone-progress', progress)
          }
        }
      }
    )
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('Clone aborted')
    }
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('Clone failed:')) {
      throw new Error(`Clone failed: ${getGitCloneFailureMessage(message, { clonePath })}`)
    }
    throw err
  } finally {
    if (activeRemoteClone === metadata) {
      activeRemoteClone = null
    }
    remoteCloneInFlightByPath.delete(remoteCloneKey)
  }
  if (existing && isFolderRepo(existing)) {
    const updated = store.updateRepo(existing.id, {
      kind: 'git',
      projectHostSetupMethod: 'cloned'
    })
    if (updated) {
      emitRepoAdded('clone_url', false)
      getActiveMultiplexer(args.connectionId)?.notify('session.registerRoot', {
        rootPath: clonePath
      })
      return updated
    }
  }
  const result = await addRemoteRepoFromPath(store, {
    connectionId: args.connectionId,
    remotePath: clonePath,
    kind: 'git',
    setupMethod: 'cloned'
  })
  if ('error' in result) {
    throw new Error(result.error)
  }
  emitRepoAdded('clone_url', result.alreadyExisted)
  return result.repo
}

async function createRemoteRepo(
  store: Store,
  args: {
    connectionId: string
    parentPath: string
    name: string
    kind: 'git' | 'folder'
  }
): Promise<{ repo: Repo } | { error: string }> {
  const name = args.name?.trim() ?? ''
  const parentPath = await resolveRemoteHomePath(args.connectionId, args.parentPath?.trim() ?? '')
  const repoKind: 'git' | 'folder' = args.kind === 'folder' ? 'folder' : 'git'
  if (!name) {
    return { error: 'Name cannot be empty' }
  }
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    return { error: 'Name cannot contain slashes or be "." / ".."' }
  }
  if (!parentPath) {
    return { error: 'Parent directory is required' }
  }
  const gitProvider = getSshGitProvider(args.connectionId)
  const fsProvider = getSshFilesystemProvider(args.connectionId)
  if (!gitProvider || !fsProvider) {
    return { error: `SSH connection "${args.connectionId}" not found or not connected` }
  }
  const host = gitProvider.getHostPlatform?.()
  if (!host) {
    return { error: 'SSH host platform is unavailable. Reconnect the SSH target before creating.' }
  }
  if (!isRuntimePathAbsolute(parentPath, host.pathFlavor)) {
    return { error: 'Parent directory must be an absolute path on the SSH host' }
  }

  const targetPath = joinRemotePath(host, parentPath, name)
  if (relativePathInsideRoot(parentPath, targetPath) === null) {
    return { error: 'Project path must be inside the parent directory' }
  }
  const targetPathKey = normalizeRuntimePathForComparison(targetPath)
  const existing = store.getRepos().find((repo) => {
    return (
      repo.connectionId === args.connectionId &&
      normalizeRuntimePathForComparison(repo.path) === targetPathKey
    )
  })
  if (existing) {
    emitRepoAdded('folder_picker', true)
    return { repo: existing }
  }

  let createdDir = false
  let targetExists = false
  try {
    await fsProvider.stat(targetPath)
    targetExists = true
  } catch {
    targetExists = false
  }

  if (targetExists) {
    try {
      const entries = await fsProvider.readDir(targetPath)
      if (entries.length > 0) {
        return { error: `"${name}" already exists at this location and is not empty.` }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { error: `Failed to read directory: ${message}` }
    }
  } else {
    try {
      await fsProvider.createDirNoClobber(targetPath)
      createdDir = true
    } catch (err) {
      const raceWinner = store.getRepos().find((repo) => {
        return (
          repo.connectionId === args.connectionId &&
          normalizeRuntimePathForComparison(repo.path) === targetPathKey
        )
      })
      if (raceWinner) {
        return { repo: raceWinner }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { error: `Failed to create directory: ${message}` }
    }
  }

  if (repoKind === 'git') {
    let step: 'init' | 'commit' = 'init'
    try {
      await gitProvider.exec(['init'], targetPath)
      step = 'commit'
      await gitProvider.exec(['commit', '--allow-empty', '-m', 'Initial commit'], targetPath)
    } catch (err) {
      if (createdDir) {
        await fsProvider.deletePath(targetPath, true).catch(() => undefined)
      } else if (step === 'commit') {
        await fsProvider
          .deletePath(joinRemotePath(host, targetPath, '.git'), true)
          .catch(() => undefined)
      }
      const message = err instanceof Error ? err.message : String(err)
      if (step === 'commit' && /Please tell me who you are|user\.name|user\.email/i.test(message)) {
        return {
          error:
            'Git author identity is not configured on the SSH host. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` on that host, then try again.'
        }
      }
      const stepLabel =
        step === 'init' ? 'Failed to initialize git repository' : 'Failed to create initial commit'
      return { error: `${stepLabel}: ${message}` }
    }
  }

  const raceWinner = store.getRepos().find((repo) => {
    return (
      repo.connectionId === args.connectionId &&
      normalizeRuntimePathForComparison(repo.path) === targetPathKey
    )
  })
  if (raceWinner) {
    emitRepoAdded('folder_picker', true)
    return { repo: raceWinner }
  }

  const result = await addRemoteRepoFromPath(store, {
    connectionId: args.connectionId,
    remotePath: targetPath,
    kind: repoKind,
    displayName: name
  })
  if ('error' in result) {
    return result
  }
  emitRepoAdded('folder_picker', result.alreadyExisted)
  return { repo: result.repo }
}

async function resolveRemoteHomePath(connectionId: string, path: string): Promise<string> {
  if (path !== '~' && path !== '~/' && !path.startsWith('~/')) {
    return path
  }
  const mux = getActiveMultiplexer(connectionId)
  if (!mux) {
    return path
  }
  try {
    const result = (await mux.request('session.resolveHome', { path })) as { resolvedPath: string }
    return result.resolvedPath
  } catch {
    // Why: older relays may not support this; return the original path so callers surface their own validation error.
    return path
  }
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

type ActiveRemoteCloneMetadata = {
  connectionId: string
  clonePath: string
  controller: AbortController
}

// Why: module-scoped so the abort handle survives macOS window re-creation, when registerRepoHandlers re-runs.
let activeClone: ActiveCloneMetadata | null = null
let activeRemoteClone: ActiveRemoteCloneMetadata | null = null
let nextCloneGeneration = 1
const latestCloneGenerationByPath = new Map<string, number>()
const pendingAbortCleanupByPath = new Map<string, Promise<void>>()
const cloneInFlightByPath = new Map<string, Promise<void>>()
const remoteCloneInFlightByPath = new Set<string>()
const activeNestedRepoScans = new Map<string, AbortController>()
type CompletedNestedRepoScan = {
  scan: NestedRepoScanResult
  parentPath: string
  connectionId: string | null
}
const completedNestedRepoScans = new Map<string, CompletedNestedRepoScan>()
const MAX_COMPLETED_NESTED_SCAN_RESULTS = 50
const GIT_AVAILABILITY_TIMEOUT_MS = 1500

function emitCloneProgressFromText(mainWindow: BrowserWindow, text: string): void {
  for (const line of text.split(/[\r\n]+/)) {
    const match = line.match(/^([\w\s]+):\s+(\d+)%/)
    if (match && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('repos:clone-progress', {
        phase: match[1].trim(),
        percent: Number.parseInt(match[2], 10)
      })
    }
  }
}

const ProjectGroupCreateArgs = z.object({
  name: z.string().min(1),
  parentPath: z.string().nullable().optional(),
  connectionId: z.string().nullable().optional(),
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

const ProjectHostSetupExistingFolderIpcArgs = z.object({
  projectId: z.string().min(1),
  hostId: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(['git', 'folder']).optional(),
  displayName: z.string().min(1).optional(),
  setupMethod: z.enum(['imported-existing-folder', 'cloned']).optional()
})

const LocalWindowsRuntimePreferenceIpcArgs = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit-global') }),
  z.object({ kind: z.literal('windows-host') }),
  z.object({ kind: z.literal('wsl'), distro: z.string().min(1) })
])

const ProjectUpdateIpcArgs = z.object({
  projectId: z.string().min(1),
  updates: z.object({
    localWindowsRuntimePreference: LocalWindowsRuntimePreferenceIpcArgs.optional()
  })
})

const ProjectHostSetupCreateIpcArgs = z.object({
  projectId: z.string().min(1),
  hostId: z
    .string()
    .min(1)
    .transform((value, ctx) => {
      const hostId = normalizeExecutionHostId(value)
      if (!hostId) {
        ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
        return z.NEVER
      }
      return hostId
    }),
  setupId: z.string().min(1).optional(),
  path: z.string().optional(),
  kind: z.enum(['git', 'folder']).optional(),
  displayName: z.string().min(1).optional(),
  worktreeBasePath: z.string().optional(),
  gitUsername: z.string().optional(),
  setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
  setupMethod: z.enum(['imported-existing-folder', 'cloned', 'provisioned']).optional()
})

const ProjectHostSetupUpdateIpcArgs = z.object({
  setupId: z.string().min(1),
  updates: z.object({
    displayName: z.string().optional(),
    path: z.string().optional(),
    worktreeBasePath: z.string().optional(),
    setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
    setupMethod: z
      .enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned'])
      .optional(),
    gitUsername: z.string().optional(),
    kind: z.enum(['git', 'folder']).optional()
  })
})

const ProjectHostSetupDeleteIpcArgs = z.object({
  setupId: z.string().min(1)
})

const FolderWorkspaceLinkedTaskArgs = z
  .object({
    provider: z.enum(['github', 'gitlab', 'linear', 'jira']),
    type: z.enum(['issue', 'pr', 'mr']),
    number: z.number().finite(),
    title: z.string().min(1),
    url: z.string().min(1),
    linearIdentifier: z.string().min(1).optional(),
    jiraIdentifier: z.string().min(1).optional(),
    repoId: z.string().min(1).optional()
  })
  .nullable()

const FolderWorkspaceCreateArgs = z.object({
  projectGroupId: z.string().min(1),
  name: z.string().optional(),
  folderPath: z.string().nullable().optional(),
  connectionId: z.string().nullable().optional(),
  linkedTask: FolderWorkspaceLinkedTaskArgs.optional(),
  createdWithAgent: z.string().refine(isTuiAgent).optional(),
  pendingFirstAgentMessageRename: z.boolean().optional()
})

const FolderWorkspaceUpdateArgs = z.object({
  folderWorkspaceId: z.string().min(1),
  updates: z.object({
    name: z.string().optional(),
    folderPath: z.string().optional(),
    linkedTask: FolderWorkspaceLinkedTaskArgs.optional(),
    comment: z.string().optional(),
    isArchived: z.boolean().optional(),
    isUnread: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    sortOrder: z.number().finite().optional(),
    manualOrder: z.number().finite().optional(),
    workspaceStatus: z.string().optional(),
    createdWithAgent: z.string().refine(isTuiAgent).optional(),
    pendingFirstAgentMessageRename: z.boolean().optional(),
    firstAgentMessageRenameError: z.string().nullable().optional(),
    lastActivityAt: z.number().finite().optional()
  })
})

const FolderWorkspaceSelectorArgs = z.object({
  folderWorkspaceId: z.string().min(1)
})

const FolderWorkspacePathStatusArgs = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('folder-workspace'),
    folderWorkspaceId: z.string().min(1)
  }),
  z.object({
    scope: z.literal('project-group'),
    projectGroupId: z.string().min(1)
  }),
  z.object({
    scope: z.literal('path'),
    path: z.string().min(1),
    connectionId: z.string().min(1).nullable().optional()
  })
])

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
    groupName: z.string().optional().default(''),
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
  // Why: a fast retry may attach a newer process before the aborted one closes; the old close handler must not delete it.
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

async function isGitAvailable(): Promise<boolean> {
  try {
    await gitExecFileAsync(['--version'], {
      cwd: process.cwd(),
      timeout: GIT_AVAILABILITY_TIMEOUT_MS
    })
    return true
  } catch {
    return false
  }
}

function getDefaultCreateProjectParent(): string {
  return join(homedir(), 'orca', 'projects')
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
    return await runWithGitReadCacheInvalidation(task)
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
  // Remove previously registered handlers so we can re-register on macOS app re-activation (new window).
  ipcMain.removeHandler('repos:list')
  ipcMain.removeHandler('repos:add')
  ipcMain.removeHandler('repos:remove')
  ipcMain.removeHandler('repos:removeForHost')
  ipcMain.removeHandler('repos:reorder')
  ipcMain.removeHandler('repos:reorderForHost')
  ipcMain.removeHandler('repos:update')
  ipcMain.removeHandler('projects:list')
  ipcMain.removeHandler('projects:update')
  ipcMain.removeHandler('projectHostSetups:list')
  ipcMain.removeHandler('projectHostSetups:create')
  ipcMain.removeHandler('projectHostSetups:setupExistingFolder')
  ipcMain.removeHandler('projectHostSetups:update')
  ipcMain.removeHandler('projectHostSetups:delete')
  ipcMain.removeHandler('projectGroups:list')
  ipcMain.removeHandler('projectGroups:create')
  ipcMain.removeHandler('projectGroups:update')
  ipcMain.removeHandler('projectGroups:delete')
  ipcMain.removeHandler('projectGroups:moveProject')
  ipcMain.removeHandler('projectGroups:scanNested')
  ipcMain.removeHandler('projectGroups:cancelNestedScan')
  ipcMain.removeHandler('projectGroups:importNested')
  ipcMain.removeHandler('folderWorkspaces:list')
  ipcMain.removeHandler('folderWorkspaces:create')
  ipcMain.removeHandler('folderWorkspaces:update')
  ipcMain.removeHandler('folderWorkspaces:delete')
  ipcMain.removeHandler('folderWorkspaces:getPathStatus')
  ipcMain.removeHandler('repos:pickFolder')
  ipcMain.removeHandler('repos:pickFolders')
  ipcMain.removeHandler('repos:pickDirectory')
  ipcMain.removeHandler('repos:clone')
  ipcMain.removeHandler('repos:cloneAbort')
  ipcMain.removeHandler('repos:cloneRemote')
  ipcMain.removeHandler('repos:isGitAvailable')
  ipcMain.removeHandler('repos:getDefaultCreateProjectParent')
  ipcMain.removeHandler('repos:getGitUsername')
  ipcMain.removeHandler('repos:getBaseRefDefault')
  ipcMain.removeHandler('repos:searchBaseRefs')
  ipcMain.removeHandler('repos:searchBaseRefDetails')
  ipcMain.removeHandler('repos:addRemote')
  ipcMain.removeHandler('repos:create')
  ipcMain.removeHandler('repos:createRemote')
  ipcMain.removeHandler('sparsePresets:list')
  ipcMain.removeHandler('sparsePresets:save')
  ipcMain.removeHandler('sparsePresets:remove')

  ipcMain.handle('repos:list', () => {
    enrichMissingRepoGitRemoteIdentities(store, {
      onChanged: () => notifyReposChanged(mainWindow)
    })
    // Why: username resolution spawns git/gh, so keep it off this sync handler (issue #7225); it re-lists when values land.
    enrichRepoGitUsernames(store, {
      onChanged: () => notifyReposChanged(mainWindow)
    })
    return store.getRepos()
  })

  ipcMain.handle('projects:list', () => {
    enrichMissingRepoGitRemoteIdentities(store, {
      onChanged: () => notifyReposChanged(mainWindow)
    })
    return store.getProjects()
  })

  ipcMain.handle('projects:update', (_event, rawArgs: ProjectUpdateArgs): Project | null => {
    const args = parseProjectGroupIpcArgs(
      ProjectUpdateIpcArgs,
      rawArgs,
      'project_update_invalid_args'
    )
    return store.updateProject(args.projectId, args.updates)
  })

  ipcMain.handle('projectHostSetups:list', () => {
    enrichMissingRepoGitRemoteIdentities(store, {
      onChanged: () => notifyReposChanged(mainWindow)
    })
    return store.getProjectHostSetups()
  })

  ipcMain.handle(
    'projectHostSetups:create',
    (_event, rawArgs: ProjectHostSetupCreateArgs): ProjectHostSetupCreateResult => {
      const args = parseProjectGroupIpcArgs(
        ProjectHostSetupCreateIpcArgs,
        rawArgs,
        'project_host_setup_create_invalid_args'
      )
      const result = store.createProjectHostSetup(args)
      if (!result) {
        throw new Error(`Project not found: ${args.projectId}`)
      }
      notifyReposChanged(mainWindow)
      return result
    }
  )

  ipcMain.handle(
    'projectHostSetups:update',
    (_event, rawArgs: ProjectHostSetupUpdateArgs): ProjectHostSetupUpdateResult => {
      const args = parseProjectGroupIpcArgs(
        ProjectHostSetupUpdateIpcArgs,
        rawArgs,
        'project_host_setup_update_invalid_args'
      )
      const result = store.updateProjectHostSetup(args)
      if (!result) {
        throw new Error(`Project host setup not found: ${args.setupId}`)
      }
      if ('worktreeBasePath' in args.updates && result.repo) {
        void prepareLocalWorktreeRootForRepo(store, result.repo)
        invalidateAuthorizedRootsCache()
      }
      notifyReposChanged(mainWindow)
      return result
    }
  )

  ipcMain.handle(
    'projectHostSetups:delete',
    (_event, rawArgs: ProjectHostSetupDeleteArgs): ProjectHostSetupDeleteResult => {
      const args = parseProjectGroupIpcArgs(
        ProjectHostSetupDeleteIpcArgs,
        rawArgs,
        'project_host_setup_delete_invalid_args'
      )
      const result = store.deleteProjectHostSetup(args)
      if (!result) {
        throw new Error(`Project host setup not found: ${args.setupId}`)
      }
      notifyReposChanged(mainWindow)
      return result
    }
  )

  ipcMain.handle(
    'projectHostSetups:setupExistingFolder',
    async (
      _event,
      rawArgs: ProjectHostSetupExistingFolderArgs
    ): Promise<ProjectHostSetupResult> => {
      const args = parseProjectGroupIpcArgs(
        ProjectHostSetupExistingFolderIpcArgs,
        rawArgs,
        'project_host_setup_invalid_args'
      )
      const parsedHost = parseExecutionHostId(args.hostId)
      if (!parsedHost) {
        throw new Error(`Unsupported host: ${args.hostId}`)
      }
      const existingProject = store.getProjects().find((project) => project.id === args.projectId)
      if (!existingProject) {
        throw new Error(`Project not found: ${args.projectId}`)
      }

      const result =
        parsedHost.kind === 'local'
          ? await addLocalRepoFromPath(store, args.path, args.kind)
          : parsedHost.kind === 'ssh'
            ? await addRemoteRepoFromPath(store, {
                connectionId: parsedHost.targetId,
                remotePath: args.path,
                displayName: args.displayName,
                kind: args.kind
              })
            : {
                error:
                  'Runtime hosts must be set up through the runtime projectHostSetup.setupExistingFolder RPC.'
              }
      if ('error' in result) {
        throw new Error(result.error)
      }
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', result.alreadyExisted)
      const aligned = alignRepoWithRequestedProject(
        store,
        result.repo,
        args.projectId,
        args.setupMethod
      )
      if (result.alreadyExisted) {
        await prepareLocalWorktreeRootForRepo(store, aligned.repo)
      }
      return aligned
    }
  )

  ipcMain.handle('repos:isGitAvailable', () => isGitAvailable())
  ipcMain.handle('repos:getDefaultCreateProjectParent', () => getDefaultCreateProjectParent())

  ipcMain.handle('projectGroups:list', () => store.getProjectGroups())

  ipcMain.handle('folderWorkspaces:list', (): FolderWorkspace[] => store.getFolderWorkspaces())

  ipcMain.handle('folderWorkspaces:getPathStatus', async (_event, rawArgs: unknown) => {
    const args = parseProjectGroupIpcArgs(
      FolderWorkspacePathStatusArgs,
      rawArgs,
      'invalid_folder_workspace_path_status_args'
    ) as FolderWorkspacePathStatusRequest
    return getFolderWorkspacePathStatus(store, args, { getSshFilesystemProvider })
  })

  ipcMain.handle(
    'folderWorkspaces:create',
    async (_event, rawArgs: unknown): Promise<FolderWorkspace> => {
      const args = parseProjectGroupIpcArgs(
        FolderWorkspaceCreateArgs,
        rawArgs,
        'invalid_folder_workspace_create_args'
      )
      const projectGroups = store.getProjectGroups()
      const group = projectGroups.find((entry) => entry.id === args.projectGroupId)
      const folderPath =
        typeof args.folderPath === 'string' && args.folderPath.trim().length > 0
          ? args.folderPath
          : group?.parentPath
      if (!group || !folderPath) {
        throw new Error('folder_workspace_project_group_not_found')
      }
      const status = await getFolderWorkspacePathStatusForPath(
        {
          folderPath,
          projectGroupId: group.id,
          connectionId: args.connectionId ?? group.connectionId ?? null,
          projectGroups,
          repos: store.getRepos()
        },
        { getSshFilesystemProvider }
      )
      assertFolderWorkspacePathUsable(status)
      const workspace = store.createFolderWorkspace(args)
      notifyReposChanged(mainWindow)
      return workspace
    }
  )

  ipcMain.handle(
    'folderWorkspaces:update',
    async (_event, rawArgs: unknown): Promise<FolderWorkspace | null> => {
      const args = parseProjectGroupIpcArgs(
        FolderWorkspaceUpdateArgs,
        rawArgs,
        'invalid_folder_workspace_update_args'
      )
      if (
        typeof args.updates.folderPath === 'string' &&
        args.updates.folderPath.trim().length > 0
      ) {
        const workspace = store.getFolderWorkspace(args.folderWorkspaceId)
        if (!workspace) {
          return null
        }
        const projectGroups = store.getProjectGroups()
        const status = await getFolderWorkspacePathStatusForPath(
          {
            folderPath: args.updates.folderPath,
            projectGroupId: workspace.projectGroupId,
            connectionId:
              workspace.connectionId ??
              projectGroups.find((entry) => entry.id === workspace.projectGroupId)?.connectionId ??
              null,
            projectGroups,
            repos: store.getRepos()
          },
          { getSshFilesystemProvider }
        )
        assertFolderWorkspacePathUsable(status)
      }
      const updated = store.updateFolderWorkspace(args.folderWorkspaceId, args.updates)
      if (updated) {
        notifyReposChanged(mainWindow)
      }
      return updated
    }
  )

  ipcMain.handle('folderWorkspaces:delete', (_event, rawArgs: unknown): boolean => {
    const args = parseProjectGroupIpcArgs(
      FolderWorkspaceSelectorArgs,
      rawArgs,
      'invalid_folder_workspace_delete_args'
    )
    const deleted = store.removeFolderWorkspace(args.folderWorkspaceId)
    if (deleted) {
      notifyReposChanged(mainWindow)
    }
    return deleted
  })

  ipcMain.handle('projectGroups:create', (_event, rawArgs: unknown): ProjectGroup => {
    const args = parseProjectGroupIpcArgs(
      ProjectGroupCreateArgs,
      rawArgs,
      'invalid_project_group_create_args'
    )
    const group = store.createProjectGroup({
      name: args.name,
      parentPath: args.parentPath ?? null,
      connectionId: args.connectionId ?? null,
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
        connectionId: args.connectionId ?? null,
        repoPaths: selection.selectedPaths,
        createGroup: (input) => store.createProjectGroup(input)
      })
      const results: ProjectGroupImportResult['projects'] = selection.rejectedPaths.map(
        (repoPath) => ({
          path: repoPath,
          status: 'failed',
          error: 'Repository was not found in the nested repo scan result'
        })
      )
      const importedProjectIdsByRepoPath = new Map<string, string>()
      const importTargetResolver = createNestedRepoImportTargetResolver()

      for (const [projectGroupOrder, repoPath] of selection.selectedPaths.entries()) {
        try {
          let importRepoPath = repoPath
          if (args.connectionId) {
            const gitProvider = getSshGitProvider(args.connectionId)
            const check = gitProvider ? await gitProvider.isGitRepoAsync(repoPath) : null
            if (!gitProvider || !check?.isRepo) {
              results.push({
                path: repoPath,
                status: 'failed',
                error: 'Not a valid git repository'
              })
              continue
            }
            importRepoPath = await importTargetResolver.resolveSsh(repoPath, gitProvider)
          } else if (!isGitRepo(repoPath)) {
            results.push({ path: repoPath, status: 'failed', error: 'Not a valid git repository' })
            continue
          } else {
            importRepoPath = await importTargetResolver.resolveLocal(repoPath)
          }
          const normalizedImportRepoPath = normalizeRuntimePathForComparison(importRepoPath)
          const alreadyImportedProjectId =
            importedProjectIdsByRepoPath.get(normalizedImportRepoPath)
          if (alreadyImportedProjectId) {
            results.push({
              path: repoPath,
              projectId: alreadyImportedProjectId,
              status: 'already-known'
            })
            continue
          }
          const existing = store
            .getRepos()
            .find(
              (repo) =>
                (repo.connectionId ?? null) === (args.connectionId ?? null) &&
                normalizeRuntimePathForComparison(repo.path) === normalizedImportRepoPath
            )
          const group = groupResolver.getGroupForRepo(repoPath)
          if (existing) {
            if (group) {
              store.moveProjectToGroup(existing.id, group.id, projectGroupOrder)
            }
            importedProjectIdsByRepoPath.set(normalizedImportRepoPath, existing.id)
            results.push({ path: repoPath, projectId: existing.id, status: 'already-known' })
            continue
          }
          const detected = await detectRepoIconAndUpstream({
            repoPath: importRepoPath,
            kind: 'git',
            connectionId: args.connectionId
          })
          const repo: Repo = {
            id: randomUUID(),
            path: importRepoPath,
            displayName: getRepoName(importRepoPath),
            badgeColor: DEFAULT_REPO_BADGE_COLOR,
            ...detected,
            addedAt: Date.now(),
            kind: 'git',
            ...(args.connectionId ? { connectionId: args.connectionId } : {}),
            externalWorktreeVisibility: 'hide',
            externalWorktreeVisibilityLegacy: false,
            projectHostSetupMethod: 'imported-existing-folder',
            ...(group
              ? {
                  projectGroupId: group.id,
                  projectGroupOrder
                }
              : {})
          }
          store.addRepo(repo)
          await prepareLocalWorktreeRootForRepo(store, repo)
          if (args.connectionId) {
            getActiveMultiplexer(args.connectionId)?.notify('session.registerRoot', {
              rootPath: importRepoPath
            })
          }
          importedProjectIdsByRepoPath.set(normalizedImportRepoPath, repo.id)
          results.push({ path: repoPath, projectId: repo.id, status: 'imported' })
          // Why: reaches here only after the isGitRepo guard above confirmed a git repo, so always true.
          emitRepoAdded('folder_picker', false, true)
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
        for (const group of groupResolver.getCreatedGroups().toReversed()) {
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
      const result = await addLocalRepoFromPath(store, args.path, args.kind)
      if ('error' in result) {
        return result
      }
      if (result.alreadyExisted) {
        await prepareLocalWorktreeRootForRepo(store, result.repo)
      }
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', result.alreadyExisted, result.repo.kind === 'git')
      return { repo: result.repo }
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
      const result = await addRemoteRepoFromPath(store, args)
      if ('error' in result) {
        return result
      }
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', result.alreadyExisted, result.repo.kind === 'git')
      return { repo: result.repo }
    }
  )

  ipcMain.handle(
    'repos:createRemote',
    async (
      _event,
      args: {
        connectionId: string
        parentPath: string
        name: string
        kind: 'git' | 'folder'
      }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const result = await createRemoteRepo(store, args)
      if ('error' in result) {
        return result
      }
      notifyReposChanged(mainWindow)
      return result
    }
  )

  // Create a repo/folder from scratch (orca#763); git repos need an empty initial commit so HEAD has a branch ref for worktrees.
  ipcMain.handle(
    'repos:create',
    async (
      _event,
      args: { parentPath: string; name: string; kind: 'git' | 'folder' }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const name = args.name?.trim() ?? ''
      const parentPath = args.parentPath?.trim() ?? ''
      // Why: IPC input is untrusted — coerce to the narrow union so a bogus kind can't skip git init yet persist in the store.
      const repoKind: 'git' | 'folder' = args.kind === 'folder' ? 'folder' : 'git'

      if (!name) {
        return { error: 'Name cannot be empty' }
      }
      // Block slashes and ./.. so the name can't escape the chosen parent (guards direct IPC use).
      if (/[\\/]/.test(name) || name === '.' || name === '..') {
        return { error: 'Name cannot contain slashes or be "." / ".."' }
      }
      if (!parentPath) {
        return { error: 'Parent directory is required' }
      }
      // Why: block CWD-relative paths at the IPC boundary — keeps targetPath stable across process cwd changes.
      if (!isAbsolute(parentPath)) {
        return { error: 'Parent directory must be an absolute path' }
      }

      const targetPath = join(parentPath, name)

      // Dedup by path so a double-click on Create doesn't make two entries for one folder (first of three dedup checks).
      const existing = store.getRepos().find((r) => r.path === targetPath)
      if (existing) {
        emitRepoAdded('folder_picker', true, repoKind === 'git')
        return { repo: existing }
      }

      // Empty pre-existing dirs are allowed (e.g. made in Finder first); non-empty ones are rejected so we don't overwrite files.
      let createdDir = false
      let targetExists = false
      try {
        // Why: the default parent (~/orca/projects) may not exist on a fresh install; create only the parent before probing the target.
        await mkdir(parentPath, { recursive: true })
        await access(targetPath)
        targetExists = true
      } catch (err) {
        // Why: only ENOENT means the path is free; other codes are something mkdir can't fix, so surface a precise error.
        // Why: tests/non-Node errors lack a code, so treat an ENOENT-looking message as ENOENT to avoid over-rejecting.
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
          // Why: access ok but readdir failed — path exists but isn't an inspectable dir (file or perms); return a distinct error.
          const message = err instanceof Error ? err.message : String(err)
          return { error: `Failed to read directory: ${message}` }
        }
      } else {
        try {
          await mkdir(targetPath, { recursive: false })
          createdDir = true
        } catch (err) {
          // Why: EEXIST means a concurrent repos:create won the mkdir race; return its store entry instead of a confusing error.
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
        // Why: track which git step ran so catch can attribute failure; the identity-hint regex only applies during commit.
        let step: 'init' | 'commit' = 'init'
        try {
          await gitExecFileAsync(['init'], { cwd: targetPath })
          step = 'commit'
          await gitExecFileAsync(['commit', '--allow-empty', '-m', 'Initial commit'], {
            cwd: targetPath
          })
        } catch (err) {
          // Only rm the dir if we made it (pre-existing folders must survive retry); otherwise strip just the .git/ that git init created.
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

      // Why: ipcMain.handle doesn't serialize calls, so re-check dedup here to close the race between the first check and addRepo.
      const raceWinner = store.getRepos().find((r) => r.path === targetPath)
      if (raceWinner) {
        // Why: don't rm even if we made the dir — the race winner owns it; leaking an empty folder beats deleting a dir in use.
        emitRepoAdded('folder_picker', true, repoKind === 'git')
        return { repo: raceWinner }
      }

      const detected = await detectRepoIconAndUpstream({ repoPath: targetPath, kind: repoKind })
      const repo: Repo = {
        id: randomUUID(),
        path: targetPath,
        displayName: name,
        badgeColor: DEFAULT_REPO_BADGE_COLOR,
        ...detected,
        addedAt: Date.now(),
        kind: repoKind,
        ...(repoKind === 'git'
          ? {
              externalWorktreeVisibility: 'hide' as const,
              externalWorktreeVisibilityLegacy: false,
              projectHostSetupMethod: 'imported-existing-folder' as const
            }
          : {})
      }

      store.addRepo(repo)
      await prepareLocalWorktreeRootForRepo(store, repo)
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      // Why: repos:create git-inits when kind is 'git', so repoKind is the true git-vs-folder signal.
      emitRepoAdded('folder_picker', false, repoKind === 'git')
      return { repo }
    }
  )

  ipcMain.handle(
    'repos:reorder',
    (_event, args: { orderedIds: string[] }): { status: 'applied' | 'rejected' } => {
      // Why: a permutation mismatch means the renderer's drag was stale vs a concurrent add/remove; reject so it can resync.
      const ids = Array.isArray(args?.orderedIds) ? args.orderedIds : []
      const applied = store.reorderRepos(ids)
      if (applied) {
        notifyReposChanged(mainWindow)
        return { status: 'applied' }
      }
      return { status: 'rejected' }
    }
  )

  ipcMain.handle(
    'repos:reorderForHost',
    (
      _event,
      args: { orderedIds: string[]; hostId: string }
    ): { status: 'applied' | 'rejected' } => {
      const hostId = normalizeExecutionHostId(args?.hostId)
      if (!hostId) {
        return { status: 'rejected' }
      }
      const ids = Array.isArray(args?.orderedIds) ? args.orderedIds : []
      const applied = store.reorderReposForHost(ids, hostId)
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

  // Why: forget a project on one execution host without disturbing the same repo id on other hosts (SSH-workspace forget flow).
  ipcMain.handle(
    'repos:removeForHost',
    async (_event, args: { repoId: string; hostId: string }) => {
      const hostId = normalizeExecutionHostId(args.hostId)
      if (!hostId) {
        throw new Error(`Invalid host ID: ${args.hostId}`)
      }
      store.removeProjectForHost(args.repoId, hostId)
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
    }
  )

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
            | 'upstream'
            | 'hookSettings'
            | 'worktreeBaseRef'
            | 'worktreeBasePath'
            | 'kind'
            | 'symlinkPaths'
            | 'issueSourcePreference'
            | 'forkSyncMode'
            | 'externalWorktreeVisibility'
            | 'externalWorktreeVisibilityPromptDismissedAt'
            | 'externalWorktreeInboxBaselinePaths'
            | 'importedExternalWorktreePaths'
            | 'projectGroupId'
            | 'projectGroupOrder'
          >
        > & {
          sourceControlAi?: Repo['sourceControlAi'] | null
          externalWorktreeDiscoverySuppressedAt?:
            | Repo['externalWorktreeDiscoverySuppressedAt']
            | null
        }
      }
    ) => {
      // Why: TS is erased at runtime, so a garbage preference would silently collapse to 'auto' in resolveIssueSource; strip it, keeping other fields.
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
      if (
        'forkSyncMode' in updates &&
        updates.forkSyncMode !== undefined &&
        updates.forkSyncMode !== 'ask' &&
        updates.forkSyncMode !== 'safe-auto' &&
        updates.forkSyncMode !== 'off'
      ) {
        delete updates.forkSyncMode
      }
      // Why: worktree materialization calls .trim() per entry, so strip non-string[] at the boundary to avoid a silent throw later.
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
      // Why: null is the transport sentinel for clearing discovery suppression.
      if (
        'externalWorktreeDiscoverySuppressedAt' in updates &&
        updates.externalWorktreeDiscoverySuppressedAt === null
      ) {
        updates.externalWorktreeDiscoverySuppressedAt = undefined
      } else if (
        'externalWorktreeDiscoverySuppressedAt' in updates &&
        updates.externalWorktreeDiscoverySuppressedAt !== undefined &&
        (typeof updates.externalWorktreeDiscoverySuppressedAt !== 'number' ||
          !Number.isFinite(updates.externalWorktreeDiscoverySuppressedAt))
      ) {
        delete updates.externalWorktreeDiscoverySuppressedAt
      }
      if (
        'externalWorktreeInboxBaselinePaths' in updates &&
        updates.externalWorktreeInboxBaselinePaths !== undefined
      ) {
        const value = updates.externalWorktreeInboxBaselinePaths as unknown
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
          delete updates.externalWorktreeInboxBaselinePaths
        }
      }
      if (
        'importedExternalWorktreePaths' in updates &&
        updates.importedExternalWorktreePaths !== undefined
      ) {
        const value = updates.importedExternalWorktreePaths as unknown
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
          delete updates.importedExternalWorktreePaths
        }
      }
      // Why: null is the transport sentinel for clearing Source Control AI, so flow it through as undefined instead of deleting.
      if ('sourceControlAi' in updates && updates.sourceControlAi === null) {
        updates.sourceControlAi = undefined
      } else if ('sourceControlAi' in updates && updates.sourceControlAi !== undefined) {
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
          void prepareLocalWorktreeRootForRepo(store, updated)
          invalidateAuthorizedRootsCache()
        }
        notifyReposChanged(mainWindow)
      }
      return updated
    }
  )

  // ── Sparse presets ─────────────────────────────────────────────
  // Why: repo-scoped reusable directory lists for the new-workspace composer; broadcast on change so open composers refresh.

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

  ipcMain.handle('repos:pickFolders', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return []
    }
    return result.filePaths
  })

  // Why: generic folder picker, separate from pickFolder's add-project flow; a clone destination may not be a git repo yet.
  ipcMain.handle('repos:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      // Why: macOS materializes typed partial paths with directory creation on; clone/create make the final path on submit.
      properties: ['openDirectory']
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
    if (activeRemoteClone) {
      activeRemoteClone.controller.abort()
      activeRemoteClone = null
    }
  })

  ipcMain.handle(
    'repos:clone',
    async (_event, args: { url: string; destination: string }): Promise<Repo> => {
      // Why: derive the repo folder name from the URL's last segment, matching default git clone behavior.
      const clonePath = deriveValidatedClonePath(args)
      const clonePathKey = getClonePathComparisonKey(clonePath)
      return runWithClonePathLock(clonePathKey, async () => {
        await pendingAbortCleanupByPath.get(clonePathKey)
        const existingAfterPendingClone = store
          .getRepos()
          .find((r) => getClonePathComparisonKey(r.path) === clonePathKey)
        if (existingAfterPendingClone && !isFolderRepo(existingAfterPendingClone)) {
          // Why: clone_url always produces a git repo.
          emitRepoAdded('clone_url', true, true)
          return existingAfterPendingClone
        }
        // Why: gitSpawn cwd is args.destination, so it must exist before spawn (fresh installs may lack the defaulted parent).
        await mkdir(args.destination, { recursive: true })
        const claimedTarget = await claimCloneTarget(clonePath)

        // Why: spawn (not execFile) avoids the maxBuffer limit — clone progress on stderr can exceed Node's 1 MB default.
        // Why: --progress forces git to emit progress even when stderr isn't a TTY.
        const cloneMetadataRef: { current: ActiveCloneMetadata | null } = { current: null }
        await new Promise<void>((resolve, reject) => {
          // Why: use the parent destination as cwd so the runner detects a WSL path and routes through wsl.exe.
          // Why: '--' isolates the URL so a malicious URL can't be read as git flags (command injection).
          let proc: ReturnType<typeof gitSpawn>
          try {
            proc = gitSpawn(['clone', '--progress', '--', args.url, clonePath], {
              cwd: args.destination,
              // Why: without this, an auth-needing clone pops Git Credential Manager's OAuth window on Windows, unclosable in a restricted env (issue #7652).
              env: nonInteractiveGitEnv(),
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

            // Why: git progress lines use \r to overwrite in-place; parse fragments the same as SSH clone.
            emitCloneProgressFromText(mainWindow, text)
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
            // Why: only null activeClone if it still points to this proc; abort-and-retry may have reassigned it, stranding the new clone.
            if (activeClone?.process === proc) {
              activeClone = null
            }

            const cloneSucceeded = !err && code === 0 && !signal
            if (!cloneSucceeded) {
              // Why: only the process that created this target may remove it, and only after git reports failure.
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
              reject(
                new Error(`Clone failed: ${getGitCloneFailureMessage(stderrTail, { clonePath })}`)
              )
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
          // Why: check after clone (path didn't exist before); reuse+upgrade a folder repo clone landed into instead of duplicating.
          const existing = store
            .getRepos()
            .find((r) => getClonePathComparisonKey(r.path) === clonePathKey)
          if (existing) {
            if (isFolderRepo(existing)) {
              const updated = store.updateRepo(existing.id, {
                kind: 'git',
                projectHostSetupMethod: 'cloned'
              })
              if (updated) {
                await prepareLocalWorktreeRootForRepo(store, updated)
                invalidateAuthorizedRootsCache()
                notifyReposChanged(mainWindow)
                // Why: folder→git upgrade is a real new git repo provisioning event.
                emitRepoAdded('clone_url', false, true)
                return updated
              }
            }
            emitRepoAdded('clone_url', true, true)
            return existing
          }

          const detected = await detectRepoIconAndUpstream({ repoPath: clonePath, kind: 'git' })
          const repo: Repo = {
            id: randomUUID(),
            path: clonePath,
            displayName: getRepoName(clonePath),
            badgeColor: DEFAULT_REPO_BADGE_COLOR,
            ...detected,
            addedAt: Date.now(),
            kind: 'git',
            externalWorktreeVisibility: 'hide',
            externalWorktreeVisibilityLegacy: false,
            projectHostSetupMethod: 'cloned'
          }

          store.addRepo(repo)
          await prepareLocalWorktreeRootForRepo(store, repo)
          invalidateAuthorizedRootsCache()
          notifyReposChanged(mainWindow)
          emitRepoAdded('clone_url', false, true)
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

  ipcMain.handle(
    'repos:cloneRemote',
    async (
      _event,
      args: { connectionId: string; url: string; destination: string }
    ): Promise<Repo> => {
      const repo = await cloneRemoteRepo(store, mainWindow, args)
      notifyReposChanged(mainWindow)
      return repo
    }
  )

  ipcMain.handle('repos:getGitUsername', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return ''
    }
    // Why: remote repos keep their git config on the remote host, so resolve the username there.
    if (repo.connectionId) {
      const provider = getSshGitProvider(repo.connectionId)
      if (!provider) {
        return ''
      }
      return getSshGitUsername(provider, repo.path)
    }
    return resolveLocalGitUsername(repo.path)
  })

  ipcMain.handle(
    'repos:getBaseRefDefault',
    async (
      _event,
      args: { repoId: string; hostId?: ExecutionHostId }
    ): Promise<BaseRefDefaultResult> => {
      const repo = getRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        // Why: folder repos have no git state for a base ref; return null + 0 so the renderer skips a fabricated default.
        return { defaultBaseRef: null, remoteCount: 0 }
      }
      // Why: remote repos need the relay to resolve symbolic-ref where the git data lives.
      if (repo.connectionId) {
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          return { defaultBaseRef: null, remoteCount: 0 }
        }
        // Why: delegate to shared resolveDefaultBaseRefViaExec; log symbolic-ref failures here to keep the SSH transport diagnostic it otherwise swallows.
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
            // Why: 0 = unknown sentinel that suppresses the multi-remote hint.
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
      // Why: run in parallel; a remote-count failure must not break default detection.
      const [defaultBaseRef, remoteCount] = await Promise.all([
        getBaseRefDefault(repo.path),
        getRemoteCount(repo.path)
      ])
      return { defaultBaseRef, remoteCount }
    }
  )

  ipcMain.handle(
    'repos:searchBaseRefs',
    async (
      _event,
      args: { repoId: string; query: string; limit?: number; hostId?: ExecutionHostId }
    ) => {
      return (await searchBaseRefDetailsForRepo(store, args)).map((entry) => entry.refName)
    }
  )

  ipcMain.handle(
    'repos:searchBaseRefDetails',
    async (
      _event,
      args: { repoId: string; query: string; limit?: number; hostId?: ExecutionHostId }
    ) => {
      return searchBaseRefDetailsForRepo(store, args)
    }
  )
}

async function searchBaseRefDetailsForRepo(
  store: Store,
  args: { repoId: string; query: string; limit?: number; hostId?: ExecutionHostId }
): Promise<BaseRefSearchResult[]> {
  const repo = getRepoForExecutionHost(store, args.repoId, args.hostId)
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
    // Why: strip glob metacharacters to prevent glob injection (mirrors local normalizeRefSearchQuery).
    const normalizedQuery = normalizeRefSearchQuery(args.query)
    try {
      // Why: argv lives in buildSearchBaseRefsArgv so SSH and local paths cannot drift.
      const remotesResult = await provider.exec(['remote'], repo.path).catch(() => ({ stdout: '' }))
      const remotes = remotesResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const capabilities = getSshGitCapabilityCache(provider)
      const runSearch = async (patternGroup?: 'segmented' | 'branchRoot'): Promise<string> => {
        return capabilities.runWithFallback(
          'for-each-ref-exclude',
          async () =>
            (
              await provider.exec(
                buildSearchBaseRefsArgv(normalizedQuery, limit, {
                  remoteNames: remotes,
                  patternGroup
                }),
                repo.path
              )
            ).stdout,
          async () =>
            (
              await provider.exec(
                buildSearchBaseRefsArgv(normalizedQuery, limit, {
                  excludeRemoteHead: false,
                  remoteNames: remotes,
                  patternGroup
                }),
                repo.path
              )
            ).stdout,
          isForEachRefExcludeUnsupportedError
        )
      }
      // Why: delegate the parse/filter/dedup/limit pipeline to the shared helper so SSH and local paths cannot diverge.
      const searchTokens = normalizedQuery.split('/').filter((token) => token.length > 0)
      if (searchTokens.length > 1) {
        const results = await Promise.all([runSearch('segmented'), runSearch('branchRoot')])
        return mergeBaseRefSearchResultGroups(
          results.map((stdout) => parseAndFilterSearchRefDetails(stdout, limit, remotes)),
          limit
        )
      }
      return parseAndFilterSearchRefDetails(await runSearch(), limit, remotes)
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

function getRepoForExecutionHost(
  store: Store,
  repoId: string,
  hostId?: ExecutionHostId
): Repo | null {
  if (!hostId) {
    return store.getRepo(repoId) ?? null
  }
  // Why: repo ids can collide across local and SSH hosts; read must use the same host the Settings pane selected for the write.
  return (
    store
      .getRepos()
      .find((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId) ?? null
  )
}

function notifyReposChanged(mainWindow: BrowserWindow): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('repos:changed')
  }
  scheduleCurrentWorktreeBaseDirectoryWatcherSync()
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
