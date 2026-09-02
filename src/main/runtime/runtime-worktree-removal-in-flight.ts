import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'

type RemovalResult = RemoveWorktreeResult & { warning?: string }

export class RuntimeWorktreeRemovalInFlight {
  private readonly removals = new Map<
    string,
    { optionsKey: string; promise: Promise<RemovalResult> }
  >()

  get(scopeKey: string, worktreeId: string, optionsKey: string): Promise<RemovalResult> | null {
    const removal = this.removals.get(scopeKey)
    if (!removal) {
      return null
    }
    if (removal.optionsKey === optionsKey) {
      return removal.promise
    }
    throw new Error(`Worktree deletion already in progress: ${worktreeId}`)
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
