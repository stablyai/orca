import { normalize } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  getRuntimePathBasename,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { getWorktreeMirrorDistro } from '../project-runtime-git-options'
import { computeWorkspaceRoot, getWorktreePathSettings } from './worktree-logic'
import { shouldEmitBoundedWarning } from './bounded-warning-dedupe'
import { resolveWorktreeCommonGitDirectory } from './worktree-common-git-directory'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchKind,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

const missingRootWarnings = new Set<string>()
const skippedWslWarnings = new Set<string>()

export const WORKTREE_BASE_TARGET_RESOLUTION_CONCURRENCY = 8

function normalizeWatchKey(pathValue: string): string {
  return normalizeRuntimePathForComparison(normalize(pathValue))
}

async function canonicalizeExistingPath(pathValue: string): Promise<string> {
  try {
    return await realpath(pathValue)
  } catch {
    return normalize(pathValue)
  }
}

async function addTarget(
  targets: Map<string, WorktreeBaseWatchTarget>,
  kind: WorktreeBaseWatchKind,
  pathValue: string,
  config: WorktreeBaseRepoWatchConfig
): Promise<void> {
  const watchedPath = await canonicalizeExistingPath(pathValue)
  const key = `${kind}:local:${normalizeWatchKey(watchedPath)}`
  const existing = targets.get(key)
  if (existing) {
    existing.repos.set(config.repoId, config)
    return
  }
  targets.set(key, {
    key,
    kind,
    path: watchedPath,
    repos: new Map([[config.repoId, config]])
  })
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
  mirrorDistro: string | undefined
): Promise<void> {
  const pathSettings = getWorktreePathSettings(repo, settings, mirrorDistro)
  const workspaceRoot = computeWorkspaceRoot(repo.path, pathSettings)
  const config = {
    repoId: repo.id,
    repoName: getRuntimePathBasename(repo.path).replace(/\.git$/, ''),
    nestWorkspaces: pathSettings.nestWorkspaces
  }
  // UNC watching is unreliable; distro repos have no native target, but mirrored Windows repos retain their Git-common watch.
  if (isWslUncPath(repo.path)) {
    warnSkippedWslRoot(repo.id, workspaceRoot)
    return
  }
  if (isWslUncPath(workspaceRoot)) {
    warnSkippedWslRoot(repo.id, workspaceRoot)
  } else {
    try {
      if ((await stat(workspaceRoot)).isDirectory()) {
        await addTarget(targets, 'base', workspaceRoot, config)
      }
    } catch {
      const key = normalizeWatchKey(workspaceRoot)
      if (shouldEmitBoundedWarning(missingRootWarnings, key)) {
        console.warn(`[worktree-base-watcher] worktree root unavailable: ${workspaceRoot}`)
      }
    }
  }

  const commonDir = await resolveWorktreeCommonGitDirectory(repo)
  if (commonDir && !isWslUncPath(commonDir)) {
    await addTarget(targets, 'git-common', commonDir, config)
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
  // Desktop watches can inspect only locally owned disk paths.
  if (getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID) {
    await maybeAddBaseTarget(targets, repo, settings, mirrorDistro)
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
