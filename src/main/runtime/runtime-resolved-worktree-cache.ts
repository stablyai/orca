import type { ResolvedWorktree } from './runtime-worktree-path-identity'

export type ResolvedWorktreeSnapshot = {
  worktrees: ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}

type ResolvedCache = ResolvedWorktreeSnapshot & { expiresAt: number }
type ResolvedInFlight = {
  generation: number
  promise: Promise<ResolvedWorktreeSnapshot>
}
export class RuntimeResolvedWorktreeCache {
  private resolved: ResolvedCache | null = null
  private resolvedInFlight: ResolvedInFlight | null = null
  private resolvedGeneration = 0

  peek(): ResolvedCache | null {
    return this.resolved
  }

  async getSnapshot(
    compute: () => Promise<ResolvedWorktreeSnapshot>,
    ttlMs: number
  ): Promise<ResolvedWorktreeSnapshot> {
    if (this.resolved && this.resolved.expiresAt > Date.now()) {
      return this.resolved
    }
    const generation = this.resolvedGeneration
    if (this.resolvedInFlight?.generation === generation) {
      return this.resolvedInFlight.promise
    }
    const promise = compute()
    this.resolvedInFlight = { generation, promise }
    try {
      const result = await promise
      if (generation === this.resolvedGeneration) {
        // Why stamped on completion, not entry: a compute that spent longer than the TTL would
        // otherwise publish an already-expired entry, so the next poll recomputes the same slow path.
        this.resolved = { ...result, expiresAt: Date.now() + ttlMs }
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
