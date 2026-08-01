import { createHash, randomUUID } from 'node:crypto'

export type MobileSessionPublicationStamp = {
  publicationEpoch: string
  snapshotVersion: number
}

const CLIENT_NAVIGATION_EPOCH_SUFFIX = ':client-navigation'

// Why: per-client projection rewrites the epoch to `${raw}:client-navigation`
// and clients echo that projected epoch back in closeLifecycle. Comparing it
// verbatim against the raw stored epoch made every projected close read as
// 'stale-publication'.
export function normalizeClientEchoedPublicationEpoch(publicationEpoch: string): string {
  return publicationEpoch.endsWith(CLIENT_NAVIGATION_EPOCH_SUFFIX)
    ? publicationEpoch.slice(0, -CLIENT_NAVIGATION_EPOCH_SUFFIX.length)
    : publicationEpoch
}

/**
 * Why: remote clients gate session-tab frames with a same-epoch version check,
 * so cross-epoch frames apply unconditionally. The desktop renderer publishes
 * ONE stable epoch per boot; minting a fresh headless epoch per mutation made
 * that gate vacuous and let delayed frames clobber newer snapshots. This clock
 * gives the headless host the same contract: one epoch per worktree per boot
 * and a strictly-increasing version across every publish site.
 */
export class MobileSessionTabsPublicationClock {
  // Why: `:headless-merge:` suffixes must not flip per preserved-set change —
  // that re-opens the cross-epoch bypass. Boot-stable, so merged epochs stay
  // comparable within a boot and versions carry the ordering.
  readonly mergeSignature = createHash('sha1').update(randomUUID()).digest('hex').slice(0, 12)
  private readonly mintedEpochByWorktree = new Map<string, string>()
  private readonly versionFloorByWorktree = new Map<string, number>()

  next(
    worktreeId: string,
    existing?: { publicationEpoch: string; snapshotVersion: number },
    options: { mintPrefix?: string } = {}
  ): MobileSessionPublicationStamp {
    return {
      publicationEpoch: this.epoch(worktreeId, existing?.publicationEpoch, options.mintPrefix),
      snapshotVersion: this.nextVersion(worktreeId, existing?.snapshotVersion)
    }
  }

  // Reuse the stored snapshot's epoch, else the epoch already minted for this
  // worktree this boot, else mint once. The prefix (`headless`,
  // `headless-hydrated`, `headless:pty-backed`) only shapes the boot-first mint
  // so logs stay greppable by publish source.
  epoch(worktreeId: string, existingEpoch?: string, mintPrefix = 'headless'): string {
    if (existingEpoch !== undefined) {
      return existingEpoch
    }
    const minted = this.mintedEpochByWorktree.get(worktreeId)
    if (minted !== undefined) {
      return minted
    }
    const fresh = `${mintPrefix}:${Date.now().toString(36)}`
    this.mintedEpochByWorktree.set(worktreeId, fresh)
    return fresh
  }

  // Strictly increasing per worktree regardless of publish source; the floor
  // survives snapshot-map deletion/replacement within the boot.
  nextVersion(worktreeId: string, existingVersion?: number): number {
    const floor = this.versionFloorByWorktree.get(worktreeId) ?? 0
    const version = Math.max(floor, existingVersion ?? 0) + 1
    this.versionFloorByWorktree.set(worktreeId, version)
    return version
  }

  // Raise the floor to a version stored outside the clock (an accepted renderer
  // revision) so later clock versions never fall below what clients saw.
  observe(worktreeId: string, version: number): void {
    if (version > (this.versionFloorByWorktree.get(worktreeId) ?? 0)) {
      this.versionFloorByWorktree.set(worktreeId, version)
    }
  }
}
