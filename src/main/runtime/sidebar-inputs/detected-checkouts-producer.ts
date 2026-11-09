import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { Repo } from '../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../shared/worktree/types'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import { CachedScan } from './cached-scan'
import { ProducerRevision } from './producer-revision'

export type DetectedCheckoutsSources = {
  /** The git repos to list, as worktree.detectedList resolves them. */
  repos: () => readonly Repo[]
  /** worktree.detectedList's own listing for one repo. */
  listDetected: (repo: Repo) => Promise<DetectedWorktreeListResult>
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: false }
  ) => () => void
}

type Listings = ReadonlyMap<string, DetectedWorktreeListResult>

/**
 * Every git repo's detected checkouts (the imported card and new-external inbox inputs), from the
 * scan worktree.detectedList serves, keyed by host and repo. A repo whose listing fails keeps what
 * it last listed.
 */
export class DetectedCheckoutsProducer {
  readonly revision = new ProducerRevision()
  private readonly listings: CachedScan<Listings>

  constructor(private readonly sources: DetectedCheckoutsSources) {
    this.listings = new CachedScan({
      label: 'detected-checkouts',
      scan: () => this.scan(),
      demand: () => this.revision.hasListeners(),
      applied: () => this.revision.bump()
    })
    sources.onClientEvent(
      (event) => {
        if (event.type === 'worktreesChanged' || event.type === 'reposChanged') {
          this.listings.request()
        }
      },
      { consumesTerminalSideEffects: false }
    )
  }

  /** Listens and starts the first listing; a reader shows nothing for this domain until it lands. */
  watch(listener: () => void): () => void {
    const detach = this.revision.onChange(listener)
    if (!this.listings.current) {
      this.listings.request()
    }
    return detach
  }

  /** Null before the first listing applies. */
  snapshot(): Record<string, DetectedWorktreeListResult> | null {
    const current = this.listings.current
    return current ? Object.fromEntries(current) : null
  }

  private async scan(): Promise<Listings> {
    const previous = this.listings.current
    const next = new Map<string, DetectedWorktreeListResult>()
    await Promise.all(
      this.sources.repos().map(async (repo) => {
        const key = getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))
        try {
          next.set(key, await this.sources.listDetected(repo))
        } catch {
          const kept = previous?.get(key)
          if (kept) {
            next.set(key, kept)
          }
        }
      })
    )
    return next
  }
}
