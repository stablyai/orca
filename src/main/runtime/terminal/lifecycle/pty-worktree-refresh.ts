import { OrcaRuntimeWithRecordPtyWorktree } from '../identity/pty-worktree-record'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'

export abstract class OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController extends OrcaRuntimeWithRecordPtyWorktree {
  protected abstract refreshFloatingWorkspacePtyLiveness(): Set<string> | null

  /** Synchronizes PTY tracking records with running daemon sessions, querying their foreground agent states. */
  protected async refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number
  ): Promise<Set<string> | null> {
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      targetWorktreeId,
      deadline
    )
    return inventory ? new Set(inventory.livePtyIds) : null
  }
}
