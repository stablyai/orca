import { normalize } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { Store } from '../persistence'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import type { GlobalSettings, Repo } from '../../shared/types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  getRuntimePathBasename,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  computeRemoteHomeWorkspaceRoot,
  computeWorkspaceRoot,
  getWorktreePathSettings,
  hasRepoWorktreeBasePath,
  remoteWorktreePathUsesRemoteHome
} from './worktree-logic'
import { resolveSshRemoteHome } from '../ssh/ssh-remote-home'
import { shouldEmitBoundedWarning } from './bounded-warning-dedupe'
import { resolveWorktreeCommonGitDirectory } from './worktree-common-git-directory'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchKind,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

const missingRootWarnings = new Set<string>()
const skippedWslWarnings = new Set<string>()

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

async function getBaseWatchLayouts(
  repo: Repo,
  pathSettings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'>,
  connectionId: string | undefined
): Promise<{ workspaceRoot: string; nestWorkspaces: boolean }[]> {
  if (
    connectionId &&
    remoteWorktreePathUsesRemoteHome(repo.path, pathSettings, {
      useConfiguredAbsolutePath: hasRepoWorktreeBasePath(repo)
    })
  ) {
    // Why: SSH default placement mirrors the workspace layout under the remote
    // home when the relay can resolve it, while worktrees created before that
    // (or via older relays) sit beside the remote repo — watch both roots.
    const layouts = [{ workspaceRoot: resolveRuntimePath(repo.path, '..'), nestWorkspaces: false }]
    const remoteRoot = computeRemoteHomeWorkspaceRoot(await resolveSshRemoteHome(connectionId))
    if (remoteRoot) {
      layouts.push({ workspaceRoot: remoteRoot, nestWorkspaces: pathSettings.nestWorkspaces })
    }
    return layouts
  }

  return [
    {
      workspaceRoot: computeWorkspaceRoot(repo.path, pathSettings),
      nestWorkspaces: pathSettings.nestWorkspaces
    }
  ]
}

async function maybeAddBaseTarget(
  targets: Map<string, WorktreeBaseWatchTarget>,
  repo: Repo,
  settings: GlobalSettings,
  connectionId?: string
): Promise<void> {
  const pathSettings = getWorktreePathSettings(repo, settings)
  const layouts = await getBaseWatchLayouts(repo, pathSettings, connectionId)
  const remoteProvider = getRemoteProvider(connectionId)
  if (connectionId && !remoteProvider) {
    return
  }
  const repoName = getRuntimePathBasename(repo.path).replace(/\.git$/, '')
  const repoOnWslFilesystem = isWslUncPath(repo.path)
  let config: { repoId: string; repoName: string; nestWorkspaces: boolean } | undefined
  for (const { workspaceRoot, nestWorkspaces } of layouts) {
    // Why: WSL UNC roots are unreliable for native watching; avoid project-level polling.
    if (isWslUncPath(workspaceRoot) || repoOnWslFilesystem) {
      const key = `${repo.id}:${workspaceRoot}`
      if (shouldEmitBoundedWarning(skippedWslWarnings, key)) {
        console.warn(
          `[worktree-base-watcher] skipping WSL worktree root watcher for ${workspaceRoot}`
        )
      }
      continue
    }

    const layoutConfig = { repoId: repo.id, repoName, nestWorkspaces }
    config ??= layoutConfig
    try {
      const rootStat = remoteProvider
        ? await remoteProvider.stat(workspaceRoot)
        : await stat(workspaceRoot)
      if (isDirectoryStat(rootStat)) {
        await addTarget(targets, 'base', workspaceRoot, layoutConfig, connectionId)
      }
    } catch {
      const key = normalizeWatchKey(workspaceRoot)
      if (shouldEmitBoundedWarning(missingRootWarnings, key)) {
        console.warn(`[worktree-base-watcher] worktree root unavailable: ${workspaceRoot}`)
      }
    }
  }
  if (!config) {
    return
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
  if (commonDir) {
    await addTarget(targets, 'git-common', commonDir, config, connectionId)
  }
}

export async function buildWorktreeBaseDirectoryWatchTargets(
  store: Store
): Promise<Map<string, WorktreeBaseWatchTarget>> {
  const settings = store.getSettings()
  const targets = new Map<string, WorktreeBaseWatchTarget>()
  for (const repo of store.getRepos()) {
    if (isFolderRepo(repo)) {
      continue
    }
    const executionHostId = getRepoExecutionHostId(repo)
    if (executionHostId === LOCAL_EXECUTION_HOST_ID) {
      await maybeAddBaseTarget(targets, repo, settings)
    } else if (repo.connectionId) {
      await maybeAddBaseTarget(targets, repo, settings, repo.connectionId)
    }
  }
  return targets
}

export function clearWorktreeBaseDirectoryWatchTargetWarnings(): void {
  missingRootWarnings.clear()
  skippedWslWarnings.clear()
}
