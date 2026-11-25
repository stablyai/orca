import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { WorktreeRemovalNotStartedError } from '../../../workspaces/removal/worktree-removal-expectation'

type RemovalResult = RemoveWorktreeResult & { warning?: string }

export class RuntimeWorktreeRemovalInFlight {
  private readonly removals = new Map<
    string,
    { optionsKey: string; promise: Promise<RemovalResult> }
  >()

  has(scopeKey: string): boolean {
    return this.removals.has(scopeKey)
  }

  /** A guarded caller that can't join another removal's options hears that it never started. */
  get(
    scopeKey: string,
    worktreeId: string,
    optionsKey: string,
    guarded = false
  ): Promise<RemovalResult> | null {
    const removal = this.removals.get(scopeKey)
    if (!removal) {
      return null
    }
    if (removal.optionsKey === optionsKey) {
      return removal.promise
    }
    const conflict = new Error(`Worktree deletion already in progress: ${worktreeId}`)
    throw guarded ? new WorktreeRemovalNotStartedError(conflict) : conflict
  }

  track(scopeKey: string, optionsKey: string, promise: Promise<RemovalResult>): void {
    this.removals.set(scopeKey, { optionsKey, promise })
  }

  release(scopeKey: string, promise: Promise<RemovalResult>): void {
    if (this.removals.get(scopeKey)?.promise === promise) {
      this.removals.delete(scopeKey)
    }
  }
}
