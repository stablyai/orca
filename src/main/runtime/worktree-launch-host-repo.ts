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
  /** No row carries this repo id and the worktree names no host — nothing ever named a host. */
  | { kind: 'unowned' }
  /** Rival rows disagree about the host; guessing one is the cross-host leak. */
  | { kind: 'ambiguous' }

/**
 * Main-side adapter over the shared execution-host rule
 * (`src/shared/worktree-execution-host-resolution.ts`), which the renderer's owner index answers
 * with too. What is local to this side is the disposal of the two `unresolved` reasons: rival rows
 * that disagree about the host are `ambiguous` and callers throw, while an id nobody carries is
 * `unowned` — the launch path's long-standing behaviour for a worktree whose repo row has gone.
 */
export function resolveWorktreeHostRouting<T extends LaunchHostRepo & ExecutionHostOwnerRow>(
  repos: readonly T[],
  worktree: { repoId: string; hostId?: string | null }
): WorktreeHostRouting<T> {
  const resolution = resolveWorktreeExecutionHost(createRepoRowExecutionHostLookup(repos), worktree)
  if (resolution.kind === 'unresolved') {
    return resolution.reason === 'ambiguous' ? { kind: 'ambiguous' } : { kind: 'unowned' }
  }
  return { kind: 'resolved', hostId: resolution.hostId, repo: resolution.owner }
}

/**
 * The same resolution, answering "what may this client dial" rather than "which host is this on".
 * The connection comes off the *host*, not the resolved row: this is a client-dialable PTY route,
 * so a `runtime:` host contributes nothing — its nested SSH target belongs to that machine's
 * namespace and spawning against it here would dial the wrong box. The renderer wants the opposite
 * answer from the same resolution, which is why the shared type carries both.
 */
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
