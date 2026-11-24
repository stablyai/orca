import type { BranchSnapshotIdentity } from './branch-ref-snapshot-identity'
import type { BranchSnapshotOwners, Owner, Context } from './branch-ref-snapshot-owners'
import { readBranchRemoteNames } from './branch-ref-snapshot-read'

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
}
