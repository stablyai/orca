import type { HostBotListing } from './host-bot-listing'

/** Applies a fresh host listing without losing detail that its optional reads did not refresh. */
export function mergeHostBotListing(
  previous: readonly HostBotListing[],
  listing: HostBotListing,
  threads: boolean
): readonly HostBotListing[] {
  const last = previous.find((entry) => entry.hostId === listing.hostId)
  const kept =
    listing.kind === 'listed' &&
    last?.kind === 'listed' &&
    last.installationId === listing.installationId
      ? last
      : null
  const groups = kept && listing.kind === 'listed' && !listing.groups ? kept.groups : undefined
  const lineage =
    kept && listing.kind === 'listed' && listing.workerStatus === 'unavailable'
      ? {
          workspaceLineage: kept.workspaceLineage,
          worktreeLineage: kept.worktreeLineage
        }
      : {}
  const threadFacts =
    kept && !threads
      ? {
          ...(kept.links ? { links: kept.links } : {}),
          ...(kept.ownChats ? { ownChats: kept.ownChats } : {})
        }
      : {}
  return [
    ...previous.filter((entry) => entry.hostId !== listing.hostId),
    { ...listing, ...threadFacts, ...lineage, ...(groups ? { groups } : {}) }
  ]
}

/** Only retry the full listing for groups when the required lineage read also succeeded. */
export function listingNeedsGroupsRetry(listing: HostBotListing | null): boolean {
  return listing?.kind === 'listed' && listing.workerStatus === 'available' && !listing.groups
}
