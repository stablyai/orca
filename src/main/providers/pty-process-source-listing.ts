import type { PtyProcessInfo } from './pty-process-info'
import type { IPtyProvider } from './pty-provider-contract'

/**
 * One process source's answer to a listing: a daemon protocol version, or (`protocolVersion`
 * null) the in-process provider. The contact words are the ones fixed in
 * docs/reference/ssh-execution-boundary.md; a source that did not answer carries no process list,
 * because an empty one would read as a counted zero.
 */
export type PtyProcessSourceListing = {
  protocolVersion: number | null
  isCurrent: boolean
} & (
  | { contact: 'live'; processes: PtyProcessInfo[] }
  | { contact: 'exited' }
  | {
      contact: 'unverifiable'
      error: unknown
      /** Ids this app last knew the source to hold: its routes plus the ids it attached. */
      lastKnownIds: string[]
    }
)

/** Today's fail-closed contract: every source must have answered, else the first silence throws. */
export function requireCompleteProcessListing(
  listings: readonly PtyProcessSourceListing[]
): PtyProcessInfo[] {
  const processes: PtyProcessInfo[] = []
  for (const listing of listings) {
    if (listing.contact === 'unverifiable') {
      throw listing.error
    }
    if (listing.contact === 'live') {
      for (const process of listing.processes) {
        processes.push(process)
      }
    }
  }
  return processes
}

export function answeredProcesses(listings: readonly PtyProcessSourceListing[]): PtyProcessInfo[] {
  return listings.flatMap((listing) => (listing.contact === 'live' ? listing.processes : []))
}

/**
 * Ids of `worktreeId` a silent version may hold: its last-known ids (routes and attached ids) for the
 * worktree, and the worktree's saved tab bindings no answering version listed. Empty when no version
 * is silent or nothing points at a silent one; then the answered part is complete for this worktree.
 */
export function silentVersionEvidence(
  listings: readonly PtyProcessSourceListing[],
  worktreeId: string,
  persistedPaneSessionIds: readonly string[] = []
): string[] {
  const silent = listings.filter((listing) => listing.contact === 'unverifiable')
  if (silent.length === 0) {
    return []
  }
  const answeredIds = new Set(answeredProcesses(listings).map((process) => process.id))
  const evidence = new Set(persistedPaneSessionIds.filter((id) => !answeredIds.has(id)))
  const prefix = `${worktreeId}@@`
  for (const listing of silent) {
    for (const id of listing.contact === 'unverifiable' ? listing.lastKnownIds : []) {
      if (id.startsWith(prefix)) {
        evidence.add(id)
      }
    }
  }
  return [...evidence]
}

export function describeListingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Lists what answered, reporting each silent previous version. A silent current version fails the
 * listing as before, so callers keep their "not responding" state; single-source providers list as before.
 */
export async function listAnsweredProcesses(
  provider: IPtyProvider,
  onUnverifiable: (source: { protocolVersion: number | null; reason: string }) => void,
  nonCurrentDeadlineMs: number,
  /** Judge completeness for this worktree only: a silent version with no evidence of it is not reported. */
  forWorktree?: { worktreeId: string; persistedPaneSessionIds: readonly string[] }
): Promise<PtyProcessInfo[]> {
  if (!provider.listProcessesBySource) {
    return await provider.listProcesses()
  }
  // Why no deadline for the current version: a slow one must not read as silent to the activation gate.
  const listings = await provider.listProcessesBySource({ nonCurrentDeadlineMs })
  const silentCurrent = listings.find(
    (listing) => listing.isCurrent && listing.contact === 'unverifiable'
  )
  if (silentCurrent?.contact === 'unverifiable') {
    throw silentCurrent.error
  }
  if (
    forWorktree &&
    silentVersionEvidence(listings, forWorktree.worktreeId, forWorktree.persistedPaneSessionIds)
      .length === 0
  ) {
    return answeredProcesses(listings)
  }
  for (const listing of listings) {
    if (listing.contact === 'unverifiable') {
      onUnverifiable({
        protocolVersion: listing.protocolVersion,
        reason: describeListingError(listing.error)
      })
    }
  }
  return answeredProcesses(listings)
}
