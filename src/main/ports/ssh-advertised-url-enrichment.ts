// Remote PTY banners are workspace-keyed; SSH listener scans are connection-scoped.

import type { DetectedPort, EnrichedDetectedPort, PortForwardEntry } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { splitWorktreeId } from '../../shared/worktree/id'
import {
  advertisedUrlWatcher,
  type AdvertisedUrl,
  type AdvertisedUrlWatcher
} from './advertised-url-watcher'

/** Union connection workspaces because SSH scans cover the whole connection. */
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
  // Broadcast subscribers share inputs; enrichment must not mutate them.
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
    // Reconcile connection-wide listener evidence before looking up workspace-keyed banners.
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
    // Use remote PID evidence to evict banners after port reuse.
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
      // Several listeners may share a numeric port, making its banner PID ambiguous.
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
  // Persisted forwards supply no live PID proof; detected-port reconciliation handles eviction.
  return entries.map((entry) => {
    const found = watcher.lookupBest(worktreeIds, entry.remotePort)
    return found ? applyAdvertisedUrl(entry, found) : entry
  })
}
