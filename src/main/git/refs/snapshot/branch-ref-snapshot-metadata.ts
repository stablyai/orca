import type { BranchSnapshotIdentity } from './branch-ref-snapshot-identity'
import type { BranchSnapshotOwners } from './branch-ref-snapshot-owners'
import type { Owner, Context, Lease } from './branch-ref-snapshot-owners'
import { BranchSnapshotIdentityChanged } from './branch-ref-snapshot-owners'
import {
  readBranchRemoteNames,
  readBranchWorktreePaths,
  readLegacyBranchSelectors,
  LegacyBranchSnapshotTooLarge
} from './branch-ref-snapshot-read'

const MAX_CONTEXTS = 64

export class BranchSnapshotMetadata {
  constructor(private readonly cache: BranchSnapshotOwners) {}

  context(owner: Owner, identity: BranchSnapshotIdentity): Context {
    const key = identity.checkoutKey
    const existing = owner.contexts.get(key)
    if (existing) {
      return existing
    }
    if (owner.contexts.size >= MAX_CONTEXTS) {
      const oldest = owner.contexts.keys().next().value
      if (oldest !== undefined) {
        this.cache.retireContext(owner, oldest, owner.contexts.get(oldest)!)
      }
    }
    const context: Context = {
      leases: new Set(),
      remotes: Promise.resolve([])
    }
    const current = () => !owner.disposed && owner.contexts.get(key) === context
    const lease = this.cache.lease(owner, current)
    owner.contexts.set(key, context)
    context.remotes = readBranchRemoteNames(identity.cwd, identity.git)
      .then(async (remotes) => {
        await this.cache.validate(identity, owner)
        if (lease.reserve(256 + remotes.reduce((sum, name) => sum + 48 + name.length * 2, 0))) {
          context.leases.add(lease)
        } else {
          this.cache.retireContext(owner, key, context)
        }
        return remotes
      })
      .catch((error: unknown) => {
        this.cache.retireContext(owner, key, context)
        throw error
      })
    return context
  }

  async remoteNames(identity: BranchSnapshotIdentity): Promise<string[]> {
    const owner = this.cache.owner(identity)
    return owner
      ? this.context(owner, identity).remotes
      : readBranchRemoteNames(identity.cwd, identity.git)
  }

  async legacy(
    owner: Owner,
    context: Context,
    identity: BranchSnapshotIdentity
  ): Promise<ReadonlyMap<string, string>> {
    if (context.legacy) {
      return context.legacy
    }
    if (context.legacyFlight) {
      return context.legacyFlight
    }
    const valid = () => !owner.disposed && owner.contexts.get(identity.checkoutKey) === context
    const lease = this.cache.lease(owner, valid)
    const promise = readLegacyBranchSelectors(identity.cwd, identity.git, lease)
      .then(async (selectors) => {
        await this.cache.validate(identity, owner)
        if (valid()) {
          context.leases.add(lease)
          context.legacy = selectors
        } else {
          lease.release()
        }
        return selectors
      })
      .catch((error: unknown) => {
        lease.release()
        if (error instanceof LegacyBranchSnapshotTooLarge && error.intrinsic && valid()) {
          context.legacyOversized = true
        }
        throw error
      })
      .finally(() => {
        if (context.legacyFlight === promise) {
          context.legacyFlight = undefined
        }
      })
    context.legacyFlight = promise
    return promise
  }

  async worktreePaths(identity: BranchSnapshotIdentity): Promise<Map<string, string>> {
    const owner = this.cache.owner(identity)
    const admitted = owner?.generation
    if (owner?.pathsFlight && owner.pathsFlight.generation !== admitted) {
      await owner.pathsFlight.promise.catch((error: unknown) => {
        if (error instanceof BranchSnapshotIdentityChanged) {
          throw error
        }
      })
    }
    if (owner?.paths) {
      return owner.paths
    }
    if (owner?.pathsFlight) {
      return owner.pathsFlight.promise
    }
    const generation = owner?.generation
    const lease = owner
      ? this.cache.lease(owner, () => owner.generation === generation)
      : { reserve: () => false, release: () => {} }
    const promise = readBranchWorktreePaths(identity.cwd, identity.git, lease)
      .then(async (paths) => {
        await this.cache.validate(identity, owner ?? undefined)
        if (
          owner &&
          !owner.disposed &&
          owner.generation === generation &&
          'bytes' in lease &&
          lease.bytes
        ) {
          owner.paths = paths
          owner.pathsLease = lease as Lease
        } else {
          lease.release()
        }
        return paths
      })
      .catch((error: unknown) => {
        lease.release()
        throw error
      })
      .finally(() => {
        if (owner?.pathsFlight?.promise === promise) {
          owner.pathsFlight = undefined
        }
      })
    if (owner) {
      owner.pathsFlight = { generation: generation!, promise }
    }
    return promise
  }
}
