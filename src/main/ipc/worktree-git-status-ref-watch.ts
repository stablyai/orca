import { resolveRuntimePath } from '../../shared/cross-platform-path'
import { isSafeGitStatusUpstreamRef } from '../../shared/git-status-upstream-ref'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import {
  pathRelativeToWorktreeWatchRoot,
  type WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

export type GitStatusRefWatchTarget = Pick<
  WorktreeBaseWatchTarget,
  'kind' | 'connectionId' | 'repos' | 'path'
> & {
  gitStatusRefPaths: Set<string>
}

type ActiveGitStatusRefBinding = {
  worktreeId: string
  repoId: string
  connectionId?: string
  upstreamRef: string
}

type GitStatusRefResolution = {
  key: string
  worktreeId: string
  repoId: string
  connectionId?: string
  controller: AbortController
  promise: Promise<void>
  retryAt: number
}

export type GitStatusRefBindingRequest = {
  worktreeId: string
  worktreePath: string
  executionHostId: string
  connectionId?: string
  providerGeneration?: number
  branch?: string
  upstreamName?: string
}

const FAILED_RESOLUTION_RETRY_MS = 5 * 60_000

let activeBinding: ActiveGitStatusRefBinding | null = null
let activeResolution: GitStatusRefResolution | null = null

function watchMatchesBinding(
  watch: GitStatusRefWatchTarget,
  binding: ActiveGitStatusRefBinding
): boolean {
  return (
    watch.kind === 'git-common' &&
    watch.connectionId === binding.connectionId &&
    watch.repos.has(binding.repoId)
  )
}

function watchMatchesResolution(
  watch: GitStatusRefWatchTarget,
  resolution: GitStatusRefResolution
): boolean {
  return (
    watch.kind === 'git-common' &&
    watch.connectionId === resolution.connectionId &&
    watch.repos.has(resolution.repoId)
  )
}

export function applyActiveGitStatusRefBinding(watch: GitStatusRefWatchTarget): void {
  watch.gitStatusRefPaths.clear()
  if (activeBinding && watchMatchesBinding(watch, activeBinding)) {
    watch.gitStatusRefPaths.add(resolveRuntimePath(watch.path, activeBinding.upstreamRef))
  }
}

// Why: at most one worktree holds a selected upstream ref at a time, so every
// other repo's ref poll would wake only to stat nothing. Publishing the
// transition lets those pollers stay unscheduled until they actually have a ref,
// with no detection delay — rebinding is an in-process event, not a timer.
const bindingChangeListeners = new Set<() => void>()

export function onActiveGitStatusRefBindingChanged(listener: () => void): () => void {
  bindingChangeListeners.add(listener)
  return () => {
    bindingChangeListeners.delete(listener)
  }
}

function applyBindingToWatches(watches: Iterable<GitStatusRefWatchTarget>): void {
  for (const watch of watches) {
    applyActiveGitStatusRefBinding(watch)
  }
  // Snapshot first: a listener may unsubscribe while being notified.
  const listeners = Array.from(bindingChangeListeners)
  for (const listener of listeners) {
    listener()
  }
}

function clearResolutionForWorktree(
  worktreeId: string,
  getWatches: () => Iterable<GitStatusRefWatchTarget>
): void {
  if (activeResolution?.worktreeId !== worktreeId) {
    return
  }
  activeResolution.controller.abort()
  activeResolution = null
  activeBinding = null
  applyBindingToWatches(getWatches())
}

function resolutionKey(args: GitStatusRefBindingRequest): string {
  return [
    args.executionHostId,
    args.connectionId ?? '',
    args.providerGeneration ?? 0,
    args.worktreeId,
    args.worktreePath,
    args.branch,
    args.upstreamName
  ].join('\0')
}

export function updateActiveGitStatusRefBinding(
  args: GitStatusRefBindingRequest,
  getWatches: () => Iterable<GitStatusRefWatchTarget>,
  resolveUpstreamRef: (signal: AbortSignal) => Promise<string | undefined>
): Promise<void> {
  if (!args.branch || !args.upstreamName) {
    clearResolutionForWorktree(args.worktreeId, getWatches)
    return Promise.resolve()
  }

  const key = resolutionKey(args)
  if (activeResolution?.key === key && activeResolution.retryAt > Date.now()) {
    applyBindingToWatches(getWatches())
    return activeResolution.promise
  }

  activeResolution?.controller.abort()
  activeBinding = null
  applyBindingToWatches(getWatches())

  const controller = new AbortController()
  const resolution = {
    key,
    worktreeId: args.worktreeId,
    repoId: getRepoIdFromWorktreeId(args.worktreeId),
    ...(args.connectionId ? { connectionId: args.connectionId } : {}),
    controller,
    promise: Promise.resolve(),
    retryAt: Number.POSITIVE_INFINITY
  }
  resolution.promise = Promise.resolve()
    .then(() => resolveUpstreamRef(controller.signal))
    .then((upstreamRef) => {
      if (activeResolution !== resolution) {
        return
      }
      activeBinding =
        upstreamRef && isSafeGitStatusUpstreamRef(upstreamRef)
          ? {
              worktreeId: args.worktreeId,
              repoId: getRepoIdFromWorktreeId(args.worktreeId),
              ...(args.connectionId ? { connectionId: args.connectionId } : {}),
              upstreamRef
            }
          : null
      applyBindingToWatches(getWatches())
    })
    .catch(() => {
      if (activeResolution === resolution && !controller.signal.aborted) {
        resolution.retryAt = Date.now() + FAILED_RESOLUTION_RETRY_MS
      }
    })
  activeResolution = resolution
  return resolution.promise
}

export function invalidateActiveGitStatusRefResolution(
  changedWatch: GitStatusRefWatchTarget,
  getWatches: () => Iterable<GitStatusRefWatchTarget>
): void {
  if (!activeResolution || !watchMatchesResolution(changedWatch, activeResolution)) {
    return
  }
  activeResolution.controller.abort()
  activeResolution = null
  activeBinding = null
  applyBindingToWatches(getWatches())
}

export function invalidateGitStatusRefResolutionForPaths(
  changedWatch: GitStatusRefWatchTarget,
  paths: (string | undefined)[],
  getWatches: () => Iterable<GitStatusRefWatchTarget>
): void {
  const configChanged = paths.some((path) => {
    if (!path || changedWatch.kind !== 'git-common') {
      return false
    }
    const parts = pathRelativeToWorktreeWatchRoot(changedWatch.path, path)
    return parts?.length === 1 && parts[0] === 'config'
  })
  if (configChanged) {
    invalidateActiveGitStatusRefResolution(changedWatch, getWatches)
  }
}

export function clearActiveGitStatusRefBinding(): void {
  activeResolution?.controller.abort()
  activeResolution = null
  activeBinding = null
}
