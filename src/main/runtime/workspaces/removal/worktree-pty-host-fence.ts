import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { getWorktreeExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
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

export function resolveWorktreePtyHostFence(
  worktree: Parameters<typeof getWorktreeExecutionHostId>[0] & { id: string; repoId?: string },
  store: Pick<RuntimeStore, 'getRepo'> | null | undefined
): WorktreePtyHostFence {
  const repo = worktree.repoId ? store?.getRepo?.(worktree.repoId) : undefined
  const parsedHost = parseExecutionHostId(getWorktreeExecutionHostId(worktree, repo))
  return parsedHost?.kind === 'runtime'
    ? { resolvedRuntimeEnvironmentId: parsedHost.environmentId }
    : { resolvedConnectionId: parsedHost?.kind === 'ssh' ? parsedHost.targetId : null }
}
