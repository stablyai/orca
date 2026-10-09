export type WorktreePtyHostFence = {
  /** `null` is this machine; ABSENT is no fence at all, so every host matches. */
  resolvedConnectionId?: string | null
  resolvedRuntimeEnvironmentId?: string
}

/**
 * Also fences the structured sweep, through `structuredSessionTeardownHostId`, which reuses this
 * exact type so the two cannot drift. That helper narrows ABSENT to local — the one deliberate
 * difference, documented where it is made.
 */
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
