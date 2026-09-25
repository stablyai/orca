import { deleteWorktreeHistoryDir } from '../terminal-history-deletion'

/** A slept worktree has no live shell, so its terminal-history directory is no longer in use. */
export function dropSleptWorktreeTerminalHistory(
  worktreeId: string,
  connectionId: string | null
): void {
  deleteWorktreeHistoryDir(worktreeId)
  if (!connectionId) {
    return
  }
  void dropRemoteSleptWorktreeHistory(connectionId, worktreeId).catch((error: unknown) => {
    console.warn(
      `[pty:history] Remote sleep cleanup failed: ${error instanceof Error ? error.message : String(error)}`
    )
  })
}

async function dropRemoteSleptWorktreeHistory(
  connectionId: string,
  worktreeId: string
): Promise<void> {
  const { getSshPtyProvider } = await import('../ipc/pty')
  const { deleteRemoteWorktreeHistory } = await import('../remote-worktree-history-cleanup')
  await deleteRemoteWorktreeHistory(getSshPtyProvider(connectionId), worktreeId)
}
