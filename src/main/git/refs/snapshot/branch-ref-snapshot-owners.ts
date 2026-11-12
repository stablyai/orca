import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import {
  resolveBranchSnapshotIdentity,
  type BranchSnapshotIdentity
} from './branch-ref-snapshot-identity'
import type { BranchRef } from './branch-ref-snapshot-data'
import {
  BRANCH_SNAPSHOT_MAX_BYTES,
  type BranchRefSnapshot,
  type BranchSnapshotRetention
} from './branch-ref-snapshot-read'

export const BRANCH_SNAPSHOT_TTL_MS = 2 * 60_000
const MAX_OWNERS = 64
export class BranchSnapshotIdentityChanged extends Error {}

export type Lease = BranchSnapshotRetention & { bytes: number }
export type Context = {
  remotes: Promise<string[]>
  leases: Set<Lease>
  legacy?: ReadonlyMap<string, string>
  legacyFlight?: Promise<ReadonlyMap<string, string>>
  legacyOversized?: boolean
}
export type Capture = {
  snapshot: BranchRefSnapshot | null
  request: string
  page: BaseRefSearchResult[]
  locals: BranchRef[] | null
}
export type Owner = {
  key: string
  generation: number
  expiresAt: number
  disposed: boolean
  unsubscribe: () => void
  snapshot: BranchRefSnapshot | null
  snapshotLease?: Lease
  oversized: boolean
  localRefs?: readonly BranchRef[]
  localLease?: Lease
  paths?: Map<string, string>
  pathsLease?: Lease
  pathsFlight?: { generation: number; promise: Promise<Map<string, string>> }
  flight?: { generation: number; promise: Promise<Capture> }
  contexts: Map<string, Context>
  base?: Lease
}
export type BranchSnapshotSignals = {
  subscribe(commonDir: string, listener: () => void): () => void
}

export class BranchSnapshotOwners {
  private readonly owners = new Map<string, Owner>()
  private allocatedBytes = 0
  constructor(private readonly signals: BranchSnapshotSignals) {}

  lease(owner: Owner, valid = () => true): Lease {
    const lease: Lease = {
      bytes: 0,
      reserve: (bytes) => {
        if (owner.disposed || !valid()) {
          return false
        }
        for (const candidate of this.owners.values()) {
          if (this.allocatedBytes + bytes <= BRANCH_SNAPSHOT_MAX_BYTES) {
            break
          }
          if (candidate !== owner && !candidate.flight) {
            this.retire(candidate)
          }
        }
        if (this.allocatedBytes + bytes > BRANCH_SNAPSHOT_MAX_BYTES) {
          return false
        }
        this.allocatedBytes += bytes
        lease.bytes += bytes
        return true
      },
      release: () => {
        this.allocatedBytes -= lease.bytes
        lease.bytes = 0
      }
    }
    return lease
  }

  retireContext(owner: Owner, key: string, context: Context): void {
    if (owner.contexts.get(key) === context) {
      owner.contexts.delete(key)
    }
    for (const lease of context.leases) {
      lease.release()
    }
    context.leases.clear()
  }

  private invalidate(owner: Owner): void {
    owner.generation++
    owner.expiresAt = Date.now() + BRANCH_SNAPSHOT_TTL_MS
    owner.oversized = false
    owner.snapshot = null
    owner.localRefs = undefined
    owner.paths = undefined
    owner.snapshotLease?.release()
    owner.localLease?.release()
    owner.pathsLease?.release()
    for (const [key, context] of owner.contexts) {
      this.retireContext(owner, key, context)
    }
    owner.contexts.clear()
  }

  retire(owner: Owner): void {
    if (owner.disposed) {
      return
    }
    owner.disposed = true
    if (this.owners.get(owner.key) === owner) {
      this.owners.delete(owner.key)
    }
    owner.unsubscribe()
    this.invalidate(owner)
    owner.base?.release()
  }

  owner(identity: BranchSnapshotIdentity): Owner | null {
    const now = Date.now()
    for (const candidate of this.owners.values()) {
      if (!candidate.flight && candidate.expiresAt <= now) {
        this.retire(candidate)
      }
    }
    let owner = this.owners.get(identity.key)
    if (owner) {
      this.owners.delete(identity.key)
      this.owners.set(identity.key, owner)
      return owner
    }
    if (this.owners.size >= MAX_OWNERS) {
      const oldest = [...this.owners.values()].find((entry) => !entry.flight)
      if (!oldest) {
        return null
      }
      this.retire(oldest)
    }
    owner = {
      key: identity.key,
      generation: 0,
      expiresAt: now + BRANCH_SNAPSHOT_TTL_MS,
      disposed: false,
      unsubscribe: () => {},
      snapshot: null,
      oversized: false,
      contexts: new Map()
    }
    owner.base = this.lease(owner)
    if (!owner.base.reserve(1024 + 2 * (identity.key.length + identity.commonDir.length))) {
      return null
    }
    this.owners.set(identity.key, owner)
    const created = owner
    created.unsubscribe = this.signals.subscribe(identity.commonDir, () => this.invalidate(created))
    return created
  }

  async validate(identity: BranchSnapshotIdentity, owner?: Owner): Promise<void> {
    const current = await resolveBranchSnapshotIdentity(identity.cwd, identity.git)
    if (!current || current.key !== identity.key || current.checkoutKey !== identity.checkoutKey) {
      if (owner) {
        this.retire(owner)
      }
      throw new BranchSnapshotIdentityChanged()
    }
  }

  reset(): void {
    for (const owner of this.owners.values()) {
      this.retire(owner)
    }
  }
}
