import type { ResolvedWorktree } from './runtime-worktree-path-identity'

export type ResolvedWorktreeSnapshot = {
  worktrees: ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}

type ResolvedCache = ResolvedWorktreeSnapshot & { expiresAt: number; inventoryRevision: number }
type ResolvedInFlight = {
  generation: number
  inventoryRevision: number
  promise: Promise<ResolvedWorktreeSnapshot>
}
export class RuntimeResolvedWorktreeCache {
  private resolved: ResolvedCache | null = null
  private resolvedInFlight: ResolvedInFlight | null = null
  private resolvedGeneration = 0

  peek(): ResolvedCache | null {
    return this.resolved
  }

  /**
   * Why the revision and not the TTL alone: a snapshot only answers for the repos that were
   * registered when it ran. A repo added afterwards — a remote host the user just connected —
   * is missing from it for reasons that have nothing to do with what exists on that host, and
   * callers read the gap as a verdict that the worktree does not exist.
   */
  isFresh(inventoryRevision: number, now = Date.now()): boolean {
    return Boolean(
      this.resolved &&
      this.resolved.inventoryRevision === inventoryRevision &&
      this.resolved.expiresAt > now
    )
  }

  async getSnapshot(
    compute: () => Promise<ResolvedWorktreeSnapshot>,
    ttlMs: number,
    inventoryRevision: number
  ): Promise<ResolvedWorktreeSnapshot> {
    if (this.resolved && this.isFresh(inventoryRevision)) {
      return this.resolved
    }
    const generation = this.resolvedGeneration
    if (
      this.resolvedInFlight?.generation === generation &&
      this.resolvedInFlight.inventoryRevision === inventoryRevision
    ) {
      return this.resolvedInFlight.promise
    }
    const promise = compute()
    this.resolvedInFlight = { generation, inventoryRevision, promise }
    try {
      const result = await promise
      if (generation === this.resolvedGeneration) {
        // Why stamped on completion, not entry: a compute that spent longer than the TTL would
        // otherwise publish an already-expired entry, so the next poll recomputes the same slow path.
        this.resolved = { ...result, inventoryRevision, expiresAt: Date.now() + ttlMs }
      }
      return result
    } finally {
      if (this.resolvedInFlight?.promise === promise) {
        this.resolvedInFlight = null
      }
    }
  }

  invalidateResolved(): void {
    this.resolvedGeneration += 1
    this.resolved = null
  }
}
