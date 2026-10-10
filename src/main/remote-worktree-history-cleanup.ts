import type { IPtyProvider } from './providers/pty-provider-contract'

/** Best-effort cleanup through the PTY owner; older relays may not expose the method. */
export async function deleteRemoteWorktreeHistory(
  provider: IPtyProvider | undefined,
  worktreeId: string
): Promise<void> {
  try {
    await provider?.deleteWorktreeHistory?.(worktreeId)
  } catch (error) {
    console.warn(
      `[pty:history] Remote cleanup unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
