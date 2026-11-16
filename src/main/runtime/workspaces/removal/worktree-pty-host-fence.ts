import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'

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
    return parseRemoteRuntimePtyId(ptyId)?.environmentId === fence.resolvedRuntimeEnvironmentId
  }
  return (
    fence.resolvedConnectionId === undefined ||
    (connectionId ?? null) === fence.resolvedConnectionId
  )
}
