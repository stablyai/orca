import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost,
  type ExecutionHostOwnerRow
} from '../../shared/worktree-execution-host-resolution'
import { getSshTargetIdForExecutionHost } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'

export type LaunchHostRepo = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

export type WorktreeLaunchHostResolution<T extends LaunchHostRepo> =
  | { kind: 'resolved'; repo: T | null; connectionId: string | null }
  | { kind: 'ambiguous' }

/**
 * Main-side adapter over the shared execution-host rule
 * (`src/shared/worktree-execution-host-resolution.ts`), which the renderer's owner index answers
 * with too. Two things are local to this side:
 *
 * - rival rows that disagree about the host are `ambiguous` and the launch scope throws, while an
 *   id nobody carries stays "no repo, no connection" — the launch path's long-standing behaviour
 *   for a worktree whose repo row has gone;
 * - the connection comes off the *host*, not the resolved row. This is a client-dialable PTY
 *   route, so a `runtime:` host contributes nothing: its nested SSH target belongs to that
 *   machine's namespace and spawning against it here would dial the wrong box. The renderer wants
 *   the opposite answer from the same resolution, which is why the shared type carries both.
 */
export function resolveWorktreeLaunchHost<T extends LaunchHostRepo & ExecutionHostOwnerRow>(
  repos: readonly T[],
  worktree: { repoId: string; hostId?: string | null }
): WorktreeLaunchHostResolution<T> {
  const resolution = resolveWorktreeExecutionHost(createRepoRowExecutionHostLookup(repos), worktree)
  if (resolution.kind === 'unresolved') {
    return resolution.reason === 'ambiguous'
      ? { kind: 'ambiguous' }
      : { kind: 'resolved', repo: null, connectionId: null }
  }
  return {
    kind: 'resolved',
    repo: resolution.owner,
    connectionId: getSshTargetIdForExecutionHost(resolution.hostId)
  }
}
