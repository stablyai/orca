import { normalize } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  getRuntimePathBasename,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  getSshFilesystemProvider,
  getSshFilesystemProviderGeneration
} from '../providers/ssh-filesystem-dispatch'
import {
  computeWorkspaceRoot,
  getWorktreePathSettings,
  hasRepoWorktreeBasePath
} from './worktree-logic'
import { shouldEmitBoundedWarning } from './bounded-warning-dedupe'
import { probeWorktreeCommonGitDirectory } from './worktree-common-git-directory'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchKind,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

const missingRootWarnings = new Set<string>()
const skippedWslWarnings = new Set<string>()
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Worktree base directory watch target build aborted')
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function normalizeWatchKey(pathValue: string): string {
  return normalizeRuntimePathForComparison(normalize(pathValue))
}

async function canonicalizeExistingPath(
  pathValue: string,
  connectionId: string | undefined
): Promise<string> {
  if (connectionId) {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      return normalize(pathValue)
    }
    try {
      return await provider.realpath(pathValue)
    } catch {
      return normalize(pathValue)
    }
  }
  try {
    return await realpath(pathValue)
  } catch {
    return normalize(pathValue)
  }
}

function isDirectoryStat(value: Stats | FileStat | undefined): boolean {
  if (!value) {
    return false
  }
  return 'type' in value ? value.type === 'directory' : value.isDirectory()
}

async function addTarget(
  targets: Map<string, WorktreeBaseWatchTarget>,
  kind: WorktreeBaseWatchKind,
  pathValue: string,
  config: WorktreeBaseRepoWatchConfig,
  connectionId?: string,
  signal?: AbortSignal
): Promise<void> {
  const watchedPath = await canonicalizeExistingPath(pathValue, connectionId)
  throwIfAborted(signal)
  const key = `${kind}:${connectionId ?? 'local'}:${normalizeWatchKey(watchedPath)}`
  const existing = targets.get(key)
  if (existing) {
    existing.repos.set(config.repoId, config)
    return
  }
  targets.set(key, {
    key,
    kind,
    path: watchedPath,
    ...(connectionId
      ? {
          connectionId,
          providerGeneration: getSshFilesystemProviderGeneration(connectionId)
        }
      : {}),
    repos: new Map([[config.repoId, config]])
  })
}

function getRemoteProvider(connectionId: string | undefined): IFilesystemProvider | undefined {
  return connectionId ? getSshFilesystemProvider(connectionId) : undefined
}

function isRuntimePathAbsoluteForRepo(repoPath: string, pathValue: string): boolean {
  const pathFlavor =
    isWindowsAbsolutePathLike(repoPath) || isWindowsAbsolutePathLike(pathValue)
      ? 'windows'
      : 'posix'
  return isRuntimePathAbsolute(pathValue, pathFlavor)
}

function getBaseWatchLayout(
  repo: Repo,
  pathSettings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'>,
  connectionId: string | undefined
): { workspaceRoot: string; nestWorkspaces: boolean } {
  if (
    connectionId &&
    !hasRepoWorktreeBasePath(repo) &&
    isRuntimePathAbsoluteForRepo(repo.path, pathSettings.workspaceDir)
  ) {
    // Why: SSH creates default worktrees beside the remote repo when the
    // global workspace dir is a desktop-local absolute path.
    return { workspaceRoot: resolveRuntimePath(repo.path, '..'), nestWorkspaces: false }
  }

  return {
    workspaceRoot: computeWorkspaceRoot(repo.path, pathSettings),
    nestWorkspaces: pathSettings.nestWorkspaces
  }
}

async function maybeAddBaseTarget(
  targets: Map<string, WorktreeBaseWatchTarget>,
  repo: Repo,
  settings: GlobalSettings,
  connectionId?: string,
  signal?: AbortSignal
): Promise<boolean> {
  const pathSettings = getWorktreePathSettings(repo, settings)
  const { workspaceRoot, nestWorkspaces } = getBaseWatchLayout(repo, pathSettings, connectionId)
  // Why: WSL UNC roots are unreliable for native watching; avoid project-level polling.
  if (isWslUncPath(workspaceRoot) || isWslUncPath(repo.path)) {
    const key = `${repo.id}:${workspaceRoot}`
    if (shouldEmitBoundedWarning(skippedWslWarnings, key)) {
      console.warn(
        `[worktree-base-watcher] skipping WSL worktree root watcher for ${workspaceRoot}`
      )
    }
    return false
  }

  const config = {
    repoId: repo.id,
    repoName: getRuntimePathBasename(repo.path).replace(/\.git$/, ''),
    nestWorkspaces
  }
  const remoteProvider = getRemoteProvider(connectionId)
  if (connectionId && !remoteProvider) {
    return true
  }
  let transientFailure = false
  try {
    const rootStat = remoteProvider
      ? await remoteProvider.stat(workspaceRoot)
      : await stat(workspaceRoot)
    if (isDirectoryStat(rootStat)) {
      await addTarget(targets, 'base', workspaceRoot, config, connectionId, signal)
    }
  } catch (error) {
    throwIfAborted(signal)
    transientFailure = !isMissingPathError(error)
    const key = normalizeWatchKey(workspaceRoot)
    if (shouldEmitBoundedWarning(missingRootWarnings, key)) {
      console.warn(`[worktree-base-watcher] worktree root unavailable: ${workspaceRoot}`)
    }
  }
  throwIfAborted(signal)

  const commonDirProbe = await probeWorktreeCommonGitDirectory(
    repo,
    remoteProvider
      ? {
          stat: (path) => remoteProvider.stat(path),
          readFile: async (path) => (await remoteProvider.readFile(path)).content
        }
      : undefined
  )
  throwIfAborted(signal)
  if (commonDirProbe.path) {
    await addTarget(targets, 'git-common', commonDirProbe.path, config, connectionId, signal)
  }
  return transientFailure || commonDirProbe.transientFailure
}

export type WorktreeBaseDirectoryRepoTargetResolution = {
  targets: Map<string, WorktreeBaseWatchTarget>
  transientFailure: boolean
}

export async function resolveWorktreeBaseDirectoryWatchTargetsForRepo(
  repo: Repo,
  settings: GlobalSettings,
  signal: AbortSignal | undefined
): Promise<WorktreeBaseDirectoryRepoTargetResolution> {
  const targets = new Map<string, WorktreeBaseWatchTarget>()
  if (isFolderRepo(repo)) {
    return { targets, transientFailure: false }
  }
  const executionHostId = getRepoExecutionHostId(repo)
  const transientFailure =
    executionHostId === LOCAL_EXECUTION_HOST_ID
      ? await maybeAddBaseTarget(targets, repo, settings, undefined, signal)
      : repo.connectionId
        ? await maybeAddBaseTarget(targets, repo, settings, repo.connectionId, signal)
        : false
  throwIfAborted(signal)
  return { targets, transientFailure }
}

export function clearWorktreeBaseDirectoryWatchTargetWarnings(): void {
  missingRootWarnings.clear()
  skippedWslWarnings.clear()
}
