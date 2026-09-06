// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRecordPtyWorktree } from './orca-runtime-record-pty-worktree'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

export class OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController extends OrcaRuntimeWithRecordPtyWorktree {
  /** Synchronizes PTY tracking records with running daemon sessions, querying their foreground agent states. */
  protected async refreshPtyWorktreeRecordsFromController(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number,
    signal?: AbortSignal
  ): Promise<Set<string> | null> {
    const refreshKey = targetWorktreeId === null ? 'aggregate' : `target:${targetWorktreeId}`
    const pending = this.ptyLivenessRefreshPromises.get(refreshKey)
    if (pending) {
      return pending
    }
    const invalidationSequence = this.ptyLivenessInvalidationSequence
    const refresh = this.refreshPtyWorktreeRecordsFromControllerUncoalesced(
      resolvedWorktrees,
      targetWorktreeId,
      deadline,
      signal,
      invalidationSequence
    )
    this.ptyLivenessRefreshPromises.set(refreshKey, refresh)
    try {
      return await refresh
    } finally {
      if (this.ptyLivenessRefreshPromises.get(refreshKey) === refresh) {
        this.ptyLivenessRefreshPromises.delete(refreshKey)
      }
    }
  }

  private async refreshPtyWorktreeRecordsFromControllerUncoalesced(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null,
    deadline?: number,
    signal?: AbortSignal,
    invalidationSequence = this.ptyLivenessInvalidationSequence
  ): Promise<Set<string> | null> {
    this.ptyLivenessRefreshInProgress += 1
    try {
      const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
        resolvedWorktrees,
        targetWorktreeId,
        deadline,
        undefined,
        false,
        signal ? { signal } : undefined
      )
      if (
        inventory &&
        targetWorktreeId === null &&
        invalidationSequence === this.ptyLivenessInvalidationSequence
      ) {
        this.ptyLivenessRefreshRequired = false
      }
      return inventory ? new Set(inventory.livePtyIds) : null
    } finally {
      this.ptyLivenessRefreshInProgress -= 1
    }
  }
}
