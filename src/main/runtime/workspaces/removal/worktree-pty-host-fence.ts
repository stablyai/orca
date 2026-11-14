import { getWorktreeExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
export type WorktreePtyHostFence = {
  /** `null` is this machine; ABSENT is no fence at all, so every host matches. */
  resolvedConnectionId?: string | null
  resolvedRuntimeEnvironmentId?: string
}

/** Structured teardown reuses this fence type, deliberately narrowing an absent fence to local at its call site. */
export function worktreePtyBelongsToHost(
  ptyId: string,
  connectionId: string | null | undefined,
  fence: WorktreePtyHostFence
): boolean {
  if (fence.resolvedRuntimeEnvironmentId !== undefined) {
    return ptyId.startsWith(`remote:${encodeURIComponent(fence.resolvedRuntimeEnvironmentId)}@@`)
  }
  return (
    fence.resolvedConnectionId === undefined ||
    (connectionId ?? null) === fence.resolvedConnectionId
  )
}

export function getWorktreePtyHostFence(
  worktree: Parameters<typeof getWorktreeExecutionHostId>[0],
  repo?: Repo
): WorktreePtyHostFence {
  const host = parseExecutionHostId(getWorktreeExecutionHostId(worktree, repo))
  return host?.kind === 'runtime'
    ? { resolvedRuntimeEnvironmentId: host.environmentId }
    : { resolvedConnectionId: host?.kind === 'ssh' ? host.targetId : null }
}
