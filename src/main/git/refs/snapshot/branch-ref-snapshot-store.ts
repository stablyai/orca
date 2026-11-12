import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import type { BranchSnapshotIdentity } from './branch-ref-snapshot-identity'
import {
  BranchSnapshotOwners,
  BranchSnapshotIdentityChanged,
  BRANCH_SNAPSHOT_TTL_MS,
  type Owner,
  type Capture,
  type BranchSnapshotSignals
} from './branch-ref-snapshot-owners'
import { BranchSnapshotMetadata } from './branch-ref-snapshot-metadata'
import {
  createBranchRefProjection,
  projectBranchRefs,
  type BranchRef
} from './branch-ref-snapshot-data'
import {
  BRANCH_SNAPSHOT_MAX_BYTES,
  readBranchRefSnapshot,
  readBranchRemoteNames,
  readLegacyBranchPage,
  LegacyBranchSnapshotTooLarge
} from './branch-ref-snapshot-read'
export { BranchSnapshotIdentityChanged } from './branch-ref-snapshot-owners'

/** One physical capture per owner; each caller projects its own page or local list. */
export class BranchRefSnapshotStore {
  private readonly cache: BranchSnapshotOwners
  private readonly metadata: BranchSnapshotMetadata
  constructor(signals: BranchSnapshotSignals) {
    this.cache = new BranchSnapshotOwners(signals)
    this.metadata = new BranchSnapshotMetadata(this.cache)
  }

  private async capture(
    owner: Owner | null,
    identity: BranchSnapshotIdentity,
    request: string,
    onRef: (ref: BranchRef) => boolean | void,
    page: BaseRefSearchResult[],
    locals: BranchRef[] | null
  ): Promise<Capture> {
    const admitted = owner?.generation
    // A post-fence caller waits for the physical old read, but never consumes that generation.
    if (owner?.flight && owner.flight.generation !== admitted) {
      await owner.flight.promise.catch((error: unknown) => {
        if (error instanceof BranchSnapshotIdentityChanged) {
          throw error
        }
      })
    }
    if (owner?.snapshot) {
      return { snapshot: owner.snapshot, request, page, locals }
    }
    if (owner?.flight) {
      return owner.flight.promise
    }
    const generation = owner?.generation
    const lease = owner ? this.cache.lease(owner, () => owner.generation === generation) : undefined
    const promise = readBranchRefSnapshot(
      identity.cwd,
      identity.git,
      onRef,
      !owner || owner.oversized ? 0 : BRANCH_SNAPSHOT_MAX_BYTES,
      lease
    )
      .then(async (result): Promise<Capture> => {
        await this.cache.validate(identity, owner ?? undefined)
        if (owner && !owner.disposed && owner.generation === generation) {
          owner.snapshot = result.snapshot
          owner.oversized ||= result.oversized
          owner.expiresAt = Date.now() + BRANCH_SNAPSHOT_TTL_MS
          if (result.snapshot) {
            owner.snapshotLease = lease
          } else {
            lease?.release()
          }
        } else {
          lease?.release()
        }
        return { snapshot: result.snapshot, request, page, locals }
      })
      .catch((error: unknown) => {
        lease?.release()
        throw error
      })
      .finally(() => {
        if (owner?.flight?.promise === promise) {
          owner.flight = undefined
        }
      })
    if (owner) {
      owner.flight = { generation: generation!, promise }
    }
    return promise
  }

  async localRefs(identity: BranchSnapshotIdentity): Promise<readonly BranchRef[]> {
    const owner = this.cache.owner(identity)
    const locals: BranchRef[] = []
    const collect = (ref: BranchRef): void => {
      if (ref.refName.startsWith('refs/heads/')) {
        locals.push(ref)
      }
    }
    const capture = await this.capture(owner, identity, 'locals', collect, [], locals)
    if (capture.snapshot && owner?.snapshot === capture.snapshot && owner.localRefs) {
      return owner.localRefs
    }
    let refs = capture.snapshot
      ? sortLocalRefs(capture.snapshot.refs)
      : capture.locals
        ? sortLocalRefs(capture.locals)
        : null
    if (!refs) {
      // A different page initiated an unretainable capture; local output still requires the full population.
      await readBranchRefSnapshot(identity.cwd, identity.git, collect, 0)
      await this.cache.validate(identity)
      refs = sortLocalRefs(locals)
    }
    if (owner && capture.snapshot && owner.snapshot === capture.snapshot) {
      const lease = this.cache.lease(owner)
      if (lease.reserve(64 + refs.length * 8)) {
        owner.localRefs = refs
        owner.localLease = lease
      }
    }
    return refs
  }

  async search(
    identity: BranchSnapshotIdentity,
    query: string,
    limit: number,
    includeQualifiedRefs: boolean,
    remoteOnly = false
  ): Promise<BaseRefSearchResult[]> {
    const owner = this.cache.owner(identity)
    const context = owner ? this.metadata.context(owner, identity) : undefined
    const remotes = await (context?.remotes ?? readBranchRemoteNames(identity.cwd, identity.git))
    const legacy = includeQualifiedRefs
      ? undefined
      : owner && context && !context.legacyOversized
        ? await this.metadata.legacy(owner, context, identity).catch((error: unknown) => {
            if (error instanceof LegacyBranchSnapshotTooLarge) {
              return null
            }
            throw error
          })
        : null
    if (legacy === null) {
      const page = await readLegacyBranchPage(
        identity.cwd,
        identity.git,
        remotes,
        query,
        limit,
        remoteOnly
      )
      await this.cache.validate(identity, owner ?? undefined)
      return page
    }
    const request = JSON.stringify([
      identity.checkoutKey,
      query,
      limit,
      includeQualifiedRefs,
      remoteOnly
    ])
    const page: BaseRefSearchResult[] = []
    const project = createBranchRefProjection(remotes, query, remoteOnly, legacy)
    const collect = (ref: BranchRef): boolean => {
      if (page.length < limit) {
        const row = project(ref)
        if (row) {
          page.push(row)
        }
      }
      return page.length >= limit
    }
    const capture = await this.capture(owner, identity, request, collect, page, null)
    if (capture.snapshot) {
      return projectBranchRefs(capture.snapshot.refs, remotes, query, limit, remoteOnly, legacy)
    }
    if (capture.request === request) {
      return capture.page
    }
    await readBranchRefSnapshot(identity.cwd, identity.git, collect, 0)
    await this.cache.validate(identity, owner ?? undefined)
    return page
  }

  remoteNames(identity: BranchSnapshotIdentity) {
    return this.metadata.remoteNames(identity)
  }
  worktreePaths(identity: BranchSnapshotIdentity) {
    return this.metadata.worktreePaths(identity)
  }
  reset(): void {
    this.cache.reset()
  }
}

function sortLocalRefs(refs: readonly BranchRef[]): BranchRef[] {
  const local = refs
    .filter((ref) => ref.refName.startsWith('refs/heads/'))
    .map((ref) => ({ ref, key: Buffer.from(ref.refName) }))
  local.sort((left, right) => Buffer.compare(left.key, right.key))
  return local.map(({ ref }) => ref)
}
