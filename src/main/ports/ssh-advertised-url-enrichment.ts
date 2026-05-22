// Maps the local AdvertisedUrlWatcher cache onto SSH port shapes.
//
// SSH PTY data already flows through `runtime.onPtyData`, so the watcher
// captures URLs from remote dev servers running inside SSH-hosted terminals.
// What the SSH side lacks is the link between a connection's port scan and
// the worktreeIds the watcher keyed those URLs under.

import type { DetectedPort, EnrichedDetectedPort, PortForwardEntry } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { splitWorktreeId } from '../../shared/worktree-id'
import {
  advertisedUrlWatcher,
  type AdvertisedUrl,
  type AdvertisedUrlWatcher
} from './advertised-url-watcher'

/** Collect every worktreeId attached to a given SSH connection. The watcher
 *  is keyed per worktree, but SSH port scans are per connection, so callers
 *  need the union to find the best advertised URL across the connection. */
export function getWorktreeIdsForConnection(
  store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>,
  connectionId: string
): string[] {
  const matchingRepoIds = new Set(
    store
      .getRepos()
      .filter((repo) => repo.connectionId === connectionId)
      .map((repo) => repo.id)
  )
  if (matchingRepoIds.size === 0) {
    return []
  }
  return Object.keys(store.getAllWorktreeMeta()).filter((worktreeId) => {
    const parsed = splitWorktreeId(worktreeId)
    return parsed ? matchingRepoIds.has(parsed.repoId) : false
  })
}

export function getConnectionIdsForWorktree(
  store: Pick<Store, 'getRepos'>,
  worktreeId: string
): string[] {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed) {
    return []
  }
  const connectionId = store.getRepos().find((repo) => repo.id === parsed.repoId)?.connectionId
  return connectionId ? [connectionId] : []
}

type EnrichmentTarget = { advertisedUrl?: string; advertisedProtocol?: 'http' | 'https' }
type SshDetectedPortEnrichmentOptions = {
  validatePid?: boolean
}
type PortPidState = { kind: 'single'; pid?: number } | { kind: 'ambiguous' }

function applyAdvertisedUrl<T extends object>(
  target: T,
  found: AdvertisedUrl
): T & EnrichmentTarget {
  // Spread to keep callers' inputs immutable — important for the broadcast
  // path which sends the same array to multiple subscribers.
  return { ...target, advertisedUrl: found.origin, advertisedProtocol: found.protocol }
}

export function enrichSshDetectedPorts(
  ports: readonly DetectedPort[],
  worktreeIds: readonly string[],
  watcher: Pick<AdvertisedUrlWatcher, 'lookupBest' | 'reconcileScan'> = advertisedUrlWatcher,
  options: SshDetectedPortEnrichmentOptions = {}
): EnrichedDetectedPort[] {
  if (worktreeIds.length === 0) {
    return [...ports]
  }
  if (options.validatePid !== false) {
    // Why: SSH scans are connection-scoped while URLs are worktree-scoped; use
    // the scan snapshot to invalidate stale same-port candidates before lookup.
    watcher.reconcileScan(
      worktreeIds,
      ports.map((port) => ({ port: port.port, pid: port.pid }))
    )
  }
  if (ports.length === 0) {
    return [...ports]
  }
  const pidStateByPort = options.validatePid === false ? undefined : getPidStateByPort(ports)
  return ports.map((port) => {
    const pidState = pidStateByPort?.get(port.port)
    if (pidState?.kind === 'ambiguous') {
      return port
    }
    // Why: pass the remote listener PID so the watcher can evict stale URLs
    // when the port has been reused by a different process. The relay-side
    // scanner reads /proc/net/tcp and includes the PID when available.
    const found = watcher.lookupBest(
      worktreeIds,
      port.port,
      options.validatePid === false ? undefined : pidState?.pid
    )
    return found ? applyAdvertisedUrl(port, found) : port
  })
}

function getPidStateByPort(ports: readonly DetectedPort[]): Map<number, PortPidState> {
  const states = new Map<number, PortPidState>()
  for (const port of ports) {
    const existing = states.get(port.port)
    if (!existing) {
      states.set(port.port, { kind: 'single', pid: port.pid })
      continue
    }
    if (existing.kind === 'ambiguous') {
      continue
    }
    if (existing.pid !== port.pid || existing.pid === undefined) {
      // Why: SSH scans can report several host-specific listeners for one
      // numeric port, but advertised URLs are cached only by port.
      states.set(port.port, { kind: 'ambiguous' })
    }
  }
  return states
}

export function enrichSshForwardEntries(
  entries: readonly PortForwardEntry[],
  worktreeIds: readonly string[],
  watcher: Pick<AdvertisedUrlWatcher, 'lookupBest'> = advertisedUrlWatcher
): PortForwardEntry[] {
  if (worktreeIds.length === 0 || entries.length === 0) {
    return [...entries]
  }
  // Why: forward entries are user-configured (persisted by remotePort), not
  // observed listeners — we cannot validate against a current listener PID
  // here. Detected-port enrichment is the eviction path; whatever survives
  // there is safe to surface for the matching forward.
  return entries.map((entry) => {
    const found = watcher.lookupBest(worktreeIds, entry.remotePort)
    return found ? applyAdvertisedUrl(entry, found) : entry
  })
}
