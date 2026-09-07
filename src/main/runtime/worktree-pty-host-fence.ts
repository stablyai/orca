export type WorktreePtyHostFence = {
  resolvedConnectionId?: string | null
  resolvedRuntimeEnvironmentId?: string
}

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
