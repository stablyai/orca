import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../shared/worktree/host-qualified-identity'

export type ResolvedWorktreeSnapshot = {
  worktrees: ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}

type ResolvedCache = ResolvedWorktreeSnapshot & {
  expiresAt: number
  inventoryRevision: number
  /** The published rows by host-qualified id, built with the snapshot it belongs to. */
  byHostKey: ReadonlyMap<HostScopedWorktreeKey, ResolvedWorktree>
}
type ResolvedInFlight = {
  generation: number
  inventoryRevision: number
  promise: Promise<ResolvedWorktreeSnapshot>
}
export class RuntimeResolvedWorktreeCache {
  private resolved: ResolvedCache | null = null
  private resolvedInFlight: ResolvedInFlight | null = null
  private resolvedGeneration = 0

  get generation(): number {
    return this.resolvedGeneration
  }

  peek(): ResolvedCache | null {
    return this.resolved
  }

  /** One published row by its host and id, or undefined when none is published. */
  lookup(hostId: ExecutionHostId, worktreeId: string): ResolvedWorktree | undefined {
    return this.resolved?.byHostKey.get(composeWorktreeHostIdentity(hostId, worktreeId))
  }

  /** Revision invalidates catalogs missing newly registered repos; TTL alone could wrongly report remote worktrees absent. */
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
        // Start TTL on completion or slow computation publishes already-expired entries.
        this.resolved = {
          ...result,
          inventoryRevision,
          expiresAt: Date.now() + ttlMs,
          byHostKey: indexByHostKey(result.worktrees)
        }
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

/** Part of publishing a snapshot: one pass over rows the publication already holds. */
function indexByHostKey(
  worktrees: readonly ResolvedWorktree[]
): Map<HostScopedWorktreeKey, ResolvedWorktree> {
  const byHostKey = new Map<HostScopedWorktreeKey, ResolvedWorktree>()
  for (const worktree of worktrees) {
    const hostId = worktree.identity?.executionHostId ?? worktree.hostId
    if (hostId) {
      byHostKey.set(composeWorktreeHostIdentity(hostId, worktree.id), worktree)
    }
  }
  return byHostKey
}
