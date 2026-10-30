import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost,
  type ExecutionHostOwnerRow
} from '../../shared/worktree-execution-host-resolution'
import { getSshTargetIdForExecutionHost, type ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'

export type LaunchHostRepo = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

export type WorktreeLaunchHostResolution<T extends LaunchHostRepo> =
  | { kind: 'resolved'; repo: T | null; connectionId: string | null }
  | { kind: 'ambiguous' }

export type WorktreeHostRouting<T extends LaunchHostRepo> =
  /** `repo` is metadata; the host is the routing answer. */
  | { kind: 'resolved'; hostId: ExecutionHostId; repo: T | null }
  /** No repo row or workspace host ever named an owner. */
  | { kind: 'unowned' }
  /** Disagreeing or malformed owners are ambiguous; guessing leaks across hosts. */
  | { kind: 'ambiguous' }

/** Adapt the shared renderer/main ownership rule: unknown ids remain unowned for legacy local-folder launches; conflicting/malformed owners fail closed. */
export function resolveWorktreeHostRouting<T extends LaunchHostRepo & ExecutionHostOwnerRow>(
  repos: readonly T[],
  worktree: { repoId: string; hostId?: string | null }
): WorktreeHostRouting<T> {
  const resolution = resolveWorktreeExecutionHost(createRepoRowExecutionHostLookup(repos), worktree)
  if (resolution.kind === 'unresolved') {
    // Only a wholly unknown id permits local fallback; a malformed declared host must fail closed.
    return resolution.reason === 'unknown' ? { kind: 'unowned' } : { kind: 'ambiguous' }
  }
  return { kind: 'resolved', hostId: resolution.hostId, repo: resolution.owner }
}

/** Return only client-dialable routes from the resolved host; runtime-nested SSH ids belong to that environment's namespace. The renderer uses the shared resolution differently. */
export function resolveWorktreeLaunchHost<T extends LaunchHostRepo & ExecutionHostOwnerRow>(
  repos: readonly T[],
  worktree: { repoId: string; hostId?: string | null }
): WorktreeLaunchHostResolution<T> {
  const routing = resolveWorktreeHostRouting(repos, worktree)
  if (routing.kind === 'ambiguous') {
    return { kind: 'ambiguous' }
  }
  if (routing.kind === 'unowned') {
    return { kind: 'resolved', repo: null, connectionId: null }
  }
  return {
    kind: 'resolved',
    repo: routing.repo,
    connectionId: getSshTargetIdForExecutionHost(routing.hostId)
  }
}
