import type { Store } from '../persistence'
import { getSshFilesystemProviderGeneration } from '../providers/ssh-filesystem-dispatch'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import { resolveWorktreeBaseDirectoryWatchTargetsForRepo } from './worktree-base-directory-watch-targets'
import { getWorktreePathSettings } from './worktree-logic'

export type WorktreeBaseRepoIdentity = {
  repoId: string
  hostId: string
}

export type WorktreeBaseDirectoryWatchTargetBuildOptions = {
  fullRebuild?: boolean
  dirtyRepoIdentities?: readonly WorktreeBaseRepoIdentity[]
  dirtyConnectionIds?: readonly string[]
  signal?: AbortSignal
}

type CachedRepoTargets = {
  fingerprint: string
  targets: Map<string, WorktreeBaseWatchTarget>
}
export type WorktreeBaseDirectoryWatchTargetRetry = {
  identity: WorktreeBaseRepoIdentity
  version: string
  connectionId?: string
  providerGeneration: number
}

export type WorktreeBaseDirectoryWatchTargetBuildResult = {
  targets: Map<string, WorktreeBaseWatchTarget>
  retries: WorktreeBaseDirectoryWatchTargetRetry[]
}

const repoTargetCache = new Map<string, CachedRepoTargets>()

export function getWorktreeBaseRepoIdentity(repo: Repo): WorktreeBaseRepoIdentity {
  return {
    repoId: repo.id,
    hostId: getRepoExecutionHostId(repo)
  }
}

function getIdentityKey(identity: WorktreeBaseRepoIdentity): string {
  return `${identity.hostId}\0${identity.repoId}`
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Worktree base directory watch target build aborted')
  }
}

function getRepoTargetFingerprint(repo: Repo, settings: GlobalSettings): string {
  const pathSettings = getWorktreePathSettings(repo, settings)
  return JSON.stringify([
    repo.id,
    getRepoExecutionHostId(repo),
    repo.path,
    repo.kind ?? 'git',
    repo.connectionId ?? null,
    repo.worktreeBasePath ?? null,
    pathSettings.workspaceDir,
    pathSettings.nestWorkspaces,
    repo.connectionId ? getSshFilesystemProviderGeneration(repo.connectionId) : 0
  ])
}

function mergeRepoTargets(
  targets: Map<string, WorktreeBaseWatchTarget>,
  repoTargets: Map<string, WorktreeBaseWatchTarget>
): void {
  for (const [key, target] of repoTargets) {
    const existing = targets.get(key)
    if (existing) {
      for (const [repoId, config] of target.repos) {
        existing.repos.set(repoId, config)
      }
      continue
    }
    targets.set(key, { ...target, repos: new Map(target.repos) })
  }
}

export async function buildWorktreeBaseDirectoryWatchTargets(
  store: Store,
  options: WorktreeBaseDirectoryWatchTargetBuildOptions = {}
): Promise<WorktreeBaseDirectoryWatchTargetBuildResult> {
  const settings = store.getSettings()
  const signal = options.signal
  const liveRepos = new Map(
    store
      .getRepos()
      .map((repo) => [getIdentityKey(getWorktreeBaseRepoIdentity(repo)), repo] as const)
  )
  const fullRebuild = options.fullRebuild === true || repoTargetCache.size === 0
  const dirtyRepoKeys = new Set(options.dirtyRepoIdentities?.map(getIdentityKey) ?? [])
  const dirtyConnectionIds = new Set(options.dirtyConnectionIds ?? [])
  const nextCache = new Map<string, CachedRepoTargets>(repoTargetCache)
  const retries: WorktreeBaseDirectoryWatchTargetRetry[] = []

  for (const key of nextCache.keys()) {
    if (!liveRepos.has(key)) {
      nextCache.delete(key)
    }
  }

  for (const [identityKey, repo] of liveRepos) {
    throwIfAborted(signal)
    const fingerprint = getRepoTargetFingerprint(repo, settings)
    const cached = nextCache.get(identityKey)
    const isDirty =
      fullRebuild ||
      dirtyRepoKeys.has(identityKey) ||
      (repo.connectionId ? dirtyConnectionIds.has(repo.connectionId) : false) ||
      cached?.fingerprint !== fingerprint
    if (!isDirty) {
      continue
    }
    const resolution = await resolveWorktreeBaseDirectoryWatchTargetsForRepo(repo, settings, signal)
    throwIfAborted(signal)
    if (resolution.transientFailure) {
      retries.push({
        identity: getWorktreeBaseRepoIdentity(repo),
        version: fingerprint,
        ...(repo.connectionId ? { connectionId: repo.connectionId } : {}),
        providerGeneration: repo.connectionId
          ? getSshFilesystemProviderGeneration(repo.connectionId)
          : 0
      })
      continue
    }
    nextCache.set(identityKey, { fingerprint, targets: resolution.targets })
  }

  throwIfAborted(signal)
  repoTargetCache.clear()
  for (const [key, entry] of nextCache) {
    repoTargetCache.set(key, entry)
  }

  const targets = new Map<string, WorktreeBaseWatchTarget>()
  for (const entry of repoTargetCache.values()) {
    mergeRepoTargets(targets, entry.targets)
  }
  return { targets, retries }
}

export function clearWorktreeBaseDirectoryWatchTargetCache(): void {
  repoTargetCache.clear()
}
