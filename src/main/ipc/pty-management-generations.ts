import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import type { DaemonSessionInfo } from '../daemon/types'
import {
  listPerGeneration,
  USER_FACING_DAEMON_LISTING_TIMEOUT_MS
} from '../daemon/daemon-generation-listing'
import { describeListingError } from '../providers/pty-process-source-listing'

export type DaemonAdapterSet = { adapters: DaemonPtyAdapter[]; current: DaemonPtyAdapter | null }

/** A listed session plus whether it is the copy an open tab shows (see markTabBackedSessions). */
export type ManagedDaemonSession = DaemonSessionInfo & { backsTab: boolean }

/**
 * One daemon protocol generation and what this process actually knows about it, in the contact
 * words of docs/reference/ssh-execution-boundary.md. An `unverifiable` generation carries no
 * session list: an empty array would read as a counted zero.
 */
export type DaemonGenerationInventory = { protocolVersion: number; isCurrent: boolean } & (
  | { contact: 'live'; sessions: ManagedDaemonSession[] }
  | { contact: 'exited' }
  | { contact: 'unverifiable'; reason: 'listing-failed'; detail: string | null }
)

/** The user-facing cap applies to versions other than the current one; that one is never capped. */
export function generationDeadline(
  adapter: DaemonPtyAdapter,
  current: DaemonPtyAdapter | null,
  nonCurrentDeadlineMs: number
): number | undefined {
  return adapter === current ? undefined : nonCurrentDeadlineMs
}

/** Lists each generation at once; a silent previous one never withholds the rest past its cap. */
export async function collectGenerations(
  { adapters, current }: DaemonAdapterSet,
  nonCurrentDeadlineMs = Date.now() + USER_FACING_DAEMON_LISTING_TIMEOUT_MS,
  savedIncarnationFor: (sessionId: string) => string | undefined = () => undefined
): Promise<DaemonGenerationInventory[]> {
  const deadlineFor = (adapter: DaemonPtyAdapter): number | undefined =>
    generationDeadline(adapter, current, nonCurrentDeadlineMs)
  const listings = await listPerGeneration(
    adapters,
    (adapter) => {
      const deadlineMs = deadlineFor(adapter)
      return adapter.readSessions(deadlineMs === undefined ? undefined : { deadlineMs })
    },
    deadlineFor
  )
  const generations = listings.map(({ source: adapter, ...listing }): DaemonGenerationInventory => {
    const generation = { protocolVersion: adapter.protocolVersion, isCurrent: adapter === current }
    if (listing.contact === 'unverifiable') {
      return {
        ...generation,
        contact: 'unverifiable',
        reason: 'listing-failed',
        detail: describeListingError(listing.error)
      }
    }
    if (listing.contact === 'exited') {
      return { ...generation, contact: 'exited' }
    }
    return {
      ...generation,
      contact: 'live',
      sessions: listing.items.map<ManagedDaemonSession>((s) => ({
        ...s,
        protocolVersion: adapter.protocolVersion,
        backsTab: adapter.hasPty(s.sessionId)
      }))
    }
  })
  return markTabBackedSessions(generations, savedIncarnationFor)
}

/**
 * The copy an open tab shows is the one this app attached. Before a restored tab re-attaches no
 * copy is attached: the tab's saved incarnation for the id names it, and only when the tab saved
 * none does the only listed copy count (its own copy may sit in a version that did not answer).
 */
function markTabBackedSessions(
  generations: DaemonGenerationInventory[],
  savedIncarnationFor: (sessionId: string) => string | undefined
): DaemonGenerationInventory[] {
  const rows = generations.flatMap((g) => (g.contact === 'live' ? g.sessions : []))
  const attachedIds = new Set(rows.filter((s) => s.backsTab).map((s) => s.sessionId))
  const copiesById = new Map<string, number>()
  for (const row of rows) {
    copiesById.set(row.sessionId, (copiesById.get(row.sessionId) ?? 0) + 1)
  }
  for (const row of rows) {
    if (!row.backsTab && !attachedIds.has(row.sessionId)) {
      const saved = savedIncarnationFor(row.sessionId)
      row.backsTab =
        saved !== undefined ? row.incarnationId === saved : copiesById.get(row.sessionId) === 1
    }
  }
  return generations
}
