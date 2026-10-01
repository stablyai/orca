import type { IPtyProvider, PtyProcessInfo } from '../providers/types'
import type { PtyProcessSourceListing } from '../providers/pty-process-source-listing'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'

// Why 3 s: the runtime's own "list this host's terminals" budget; a cold daemon draining an attach
// stampede can miss 2 s, and a current version wrongly read as unverifiable is the visible error.
export const USER_FACING_DAEMON_LISTING_TIMEOUT_MS = 3_000

/** What one daemon version answered. A version that did not answer throws instead. */
export type DaemonInventoryRead<T> = { contact: 'live'; items: T[] } | { contact: 'exited' }

export type GenerationListing<S, T> = { source: S } & (
  | DaemonInventoryRead<T>
  | { contact: 'unverifiable'; error: unknown }
)

export class DaemonListingDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`listing timed out after ${timeoutMs}ms`)
    this.name = 'DaemonListingDeadlineError'
  }
}

export function withinDeadline<T>(work: Promise<T>, deadlineMs: number | undefined): Promise<T> {
  if (deadlineMs === undefined) {
    return work
  }
  const timeoutMs = Math.max(1, deadlineMs - Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DaemonListingDeadlineError(timeoutMs)), timeoutMs)
      timer.unref?.()
    })
  ]).finally(() => clearTimeout(timer))
}

/** Asks every source at once, each under its absolute deadline; one silent source never withholds the rest. */
export async function listPerGeneration<S, T>(
  sources: readonly S[],
  read: (source: S) => Promise<DaemonInventoryRead<T>>,
  deadlineMs?: number | ((source: S) => number | undefined)
): Promise<GenerationListing<S, T>[]> {
  return await Promise.all(
    sources.map(async (source): Promise<GenerationListing<S, T>> => {
      let work: Promise<DaemonInventoryRead<T>> | undefined
      try {
        work = read(source)
        const deadline = typeof deadlineMs === 'function' ? deadlineMs(source) : deadlineMs
        return { source, ...(await withinDeadline(work, deadline)) }
      } catch (error) {
        void work?.catch(() => {})
        return { source, contact: 'unverifiable', error }
      }
    })
  )
}

type ProcessSource = {
  provider: IPtyProvider
  protocolVersion: number | null
  deadlineMs: number | undefined
  read: () => Promise<DaemonInventoryRead<PtyProcessInfo>>
  activeIds: () => string[]
}

/** How long to wait: the caller's budget for the version spawning terminals, a cap for any other. */
export type ProcessSourceListingDeadlines = {
  deadlineMs?: number
  /** Earlier bound for versions other than the current one; a slow current version never reads silent. */
  nonCurrentDeadlineMs?: number
}

function sourceDeadline(isCurrent: boolean, opts: ProcessSourceListingDeadlines | undefined) {
  const { deadlineMs, nonCurrentDeadlineMs } = opts ?? {}
  if (isCurrent || nonCurrentDeadlineMs === undefined) {
    return deadlineMs
  }
  return deadlineMs === undefined
    ? nonCurrentDeadlineMs
    : Math.min(deadlineMs, nonCurrentDeadlineMs)
}

/** Router and degraded provider: each source listed on its own, derived from held state. */
export async function listDaemonProcessesBySource(
  sources: {
    adapters: readonly DaemonPtyAdapter[]
    current: DaemonPtyAdapter
    local?: IPtyProvider
  },
  routes: ReadonlyMap<string, IPtyProvider>,
  opts?: ProcessSourceListingDeadlines
): Promise<PtyProcessSourceListing[]> {
  const { adapters, current, local } = sources
  const entries: ProcessSource[] = adapters.map((adapter) => {
    const deadlineMs = sourceDeadline(adapter === current, opts)
    return {
      provider: adapter,
      protocolVersion: adapter.protocolVersion,
      deadlineMs,
      read: () => adapter.readProcesses(deadlineMs === undefined ? undefined : { deadlineMs }),
      activeIds: () => adapter.getActiveSessionIds()
    }
  })
  if (local) {
    // Why uncapped: the in-process provider is where fresh terminals go while the daemon is degraded.
    const deadlineMs = sourceDeadline(true, opts)
    entries.unshift({
      provider: local,
      protocolVersion: null,
      deadlineMs,
      read: async () => ({
        contact: 'live',
        items: await local.listProcesses(deadlineMs === undefined ? undefined : { deadlineMs })
      }),
      activeIds: () => []
    })
  }
  const listings = await listPerGeneration(
    entries,
    (entry) => entry.read(),
    (entry) => entry.deadlineMs
  )
  return listings.map(({ source, ...listing }): PtyProcessSourceListing => {
    const identity = {
      protocolVersion: source.protocolVersion,
      isCurrent: source.provider === current
    }
    if (listing.contact !== 'unverifiable') {
      return listing.contact === 'live'
        ? { ...identity, contact: 'live', processes: listing.items }
        : { ...identity, contact: 'exited' }
    }
    const lastKnownIds = new Set(source.activeIds())
    for (const [sessionId, routed] of routes) {
      if (routed === source.provider) {
        lastKnownIds.add(sessionId)
      }
    }
    return {
      ...identity,
      contact: 'unverifiable',
      error: listing.error,
      lastKnownIds: [...lastKnownIds]
    }
  })
}
