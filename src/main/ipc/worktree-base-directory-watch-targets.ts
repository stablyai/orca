import { normalize } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { Store } from '../persistence'
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
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getWorktreeMirrorDistro } from '../project-runtime-git-options'
import {
  computeWorkspaceRoot,
  getWorktreePathSettings,
  hasRepoWorktreeBasePath
} from './worktree-logic'
import { shouldEmitBoundedWarning } from './bounded-warning-dedupe'
import { resolveWorktreeCommonGitDirectory } from './worktree-common-git-directory'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchKind,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

const missingRootWarnings = new Set<string>()
const skippedWslWarnings = new Set<string>()

// Why: match existing worktree probe caps while bounding aggregate SSH filesystem RPC pressure.
export const WORKTREE_BASE_TARGET_RESOLUTION_CONCURRENCY = 8

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
  connectionId?: string
): Promise<void> {
  const watchedPath = await canonicalizeExistingPath(pathValue, connectionId)
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
    ...(connectionId ? { connectionId } : {}),
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

function warnSkippedWslRoot(repoId: string, workspaceRoot: string): void {
  if (shouldEmitBoundedWarning(skippedWslWarnings, `${repoId}:${workspaceRoot}`)) {
    console.warn(`[worktree-base-watcher] skipping WSL worktree root watcher for ${workspaceRoot}`)
  }
}

async function maybeAddBaseTarget(
  targets: Map<string, WorktreeBaseWatchTarget>,
  repo: Repo,
  settings: GlobalSettings,
  mirrorDistro: string | undefined,
  connectionId?: string
): Promise<void> {
  const pathSettings = getWorktreePathSettings(repo, settings, mirrorDistro)
  const { workspaceRoot, nestWorkspaces } = getBaseWatchLayout(repo, pathSettings, connectionId)
  const config = {
    repoId: repo.id,
    repoName: getRuntimePathBasename(repo.path).replace(/\.git$/, ''),
    nestWorkspaces
  }
  const remoteProvider = getRemoteProvider(connectionId)
  if (connectionId && !remoteProvider) {
    return
  }
  // Why: WSL UNC paths are unreliable for native watching. A repo inside the
  // distro has nothing watchable at all; a Windows-drive repo whose worktrees
  // are mirrored into the distro still has its gitdir on the Windows side.
  if (isWslUncPath(repo.path)) {
    warnSkippedWslRoot(repo.id, workspaceRoot)
    return
  }
  if (isWslUncPath(workspaceRoot)) {
    warnSkippedWslRoot(repo.id, workspaceRoot)
  } else {
    try {
      const rootStat = remoteProvider
        ? await remoteProvider.stat(workspaceRoot)
        : await stat(workspaceRoot)
      if (isDirectoryStat(rootStat)) {
        await addTarget(targets, 'base', workspaceRoot, config, connectionId)
      }
    } catch {
      const key = normalizeWatchKey(workspaceRoot)
      if (shouldEmitBoundedWarning(missingRootWarnings, key)) {
        console.warn(`[worktree-base-watcher] worktree root unavailable: ${workspaceRoot}`)
      }
    }
  }

  const commonDir = await resolveWorktreeCommonGitDirectory(
    repo,
    remoteProvider
      ? {
          stat: (path) => remoteProvider.stat(path),
          readFile: async (path) => (await remoteProvider.readFile(path)).content
        }
      : undefined
  )
  if (commonDir && !isWslUncPath(commonDir)) {
    await addTarget(targets, 'git-common', commonDir, config, connectionId)
  }
}

async function resolveRepoTargets(
  repo: Repo,
  settings: GlobalSettings,
  mirrorDistro: string | undefined
): Promise<Map<string, WorktreeBaseWatchTarget>> {
  const targets = new Map<string, WorktreeBaseWatchTarget>()
  if (isFolderRepo(repo)) {
    return targets
  }
  const executionHostId = getRepoExecutionHostId(repo)
  if (executionHostId === LOCAL_EXECUTION_HOST_ID) {
    await maybeAddBaseTarget(targets, repo, settings, mirrorDistro)
  } else if (repo.connectionId) {
    await maybeAddBaseTarget(targets, repo, settings, mirrorDistro, repo.connectionId)
  }
  return targets
}

function mergeRepoTargets(
  targets: Map<string, WorktreeBaseWatchTarget>,
  repoTargets: Map<string, WorktreeBaseWatchTarget>
): void {
  for (const [key, target] of repoTargets) {
    const existing = targets.get(key)
    if (!existing) {
      targets.set(key, target)
      continue
    }
    for (const [repoId, config] of target.repos) {
      existing.repos.set(repoId, config)
    }
  }
}

export async function buildWorktreeBaseDirectoryWatchTargets(
  store: Store
): Promise<Map<string, WorktreeBaseWatchTarget>> {
  const settings = store.getSettings()
  const resolvedRepoTargets = await mapWithConcurrency(
    store.getRepos(),
    WORKTREE_BASE_TARGET_RESOLUTION_CONCURRENCY,
    (repo) => resolveRepoTargets(repo, settings, getWorktreeMirrorDistro(store, repo))
  )
  const targets = new Map<string, WorktreeBaseWatchTarget>()
  for (const repoTargets of resolvedRepoTargets) {
    mergeRepoTargets(targets, repoTargets)
  }
  return targets
}

export function clearWorktreeBaseDirectoryWatchTargetWarnings(): void {
  missingRootWarnings.clear()
  skippedWslWarnings.clear()
}
