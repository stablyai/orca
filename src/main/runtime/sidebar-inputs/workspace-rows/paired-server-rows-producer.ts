import { ProducerRevision } from '../producer-revision'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { describePairedServerHosts } from '../../../../shared/remote-runtime/host-catalog/paired-server-hosts'
import type { MobileRelayServerWorktreeRow } from '../../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import {
  normalizePairedServerRow,
  type PairedServerRowsSnapshot
} from '../../../../shared/sidebar-list/paired-server-rows'
import type { MobileDesktopRelayHosts } from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import {
  describeRelayHosts,
  relayHostFence
} from '../../mobile-desktop-relay/mobile-relay-host-descriptions'
import type { ServerWorktreeRows } from '../../mobile-desktop-relay/mobile-relay-host-catalog'
import {
  readServerWorktreeRows,
  stampServerWorktreeRows
} from '../../mobile-desktop-relay/server-worktree-fetch'
import { fetchPairedServerCatalog } from '../../../../shared/sidebar-list/paired-server-catalog'
import type { PairedServerCatalog } from '../../../../shared/sidebar-list/sidebar-project-catalog'
import {
  newPairedServerEntry,
  wakePairedServerReaders,
  type PairedServerEntry
} from './paired-server-entry'

// Backstop for changes a server announces no event for (terminal counts, unread, PR badge) and for older servers.
export const FALLBACK_REFRESH_MS = 30_000

/** Cache paired-server rows without a window; read on contact, change events and every 30s while visible, at most once per floor. Contact gaps make rows unverifiable until a post-gap fetch; only removal/re-pair drops them. */
export class PairedServerRowsProducer implements ServerWorktreeRows {
  private readonly servers = new Map<string, PairedServerEntry>()
  private hosts: MobileDesktopRelayHosts | null = null
  readonly revision = new ProducerRevision()

  constructor(
    private readonly options: {
      hasDemand: () => boolean
      hostLabelOverrides: () => ReadonlyMap<ExecutionHostId, string>
    }
  ) {}

  attach(hosts: MobileDesktopRelayHosts): () => void {
    this.hosts = hosts
    const stopStatus = hosts.onStatusChanged(() => this.sync())
    const stopRetired = hosts.onEnvironmentRetired(() => this.sync())
    // Unwatched, it only marks rows stale; the next consumer read reads them.
    const fallback = setInterval(() => {
      for (const entry of this.servers.values()) {
        entry.gate.changed()
      }
    }, FALLBACK_REFRESH_MS)
    fallback.unref?.()
    this.sync()
    return () => {
      clearInterval(fallback)
      stopStatus()
      stopRetired()
      for (const entry of this.servers.values()) {
        this.drop(entry)
      }
      this.servers.clear()
      this.hosts = null
      this.revision.bump()
    }
  }

  /** Re-reads the configured servers: drops removed or re-paired ones, watches those in contact. */
  sync(): void {
    const hosts = this.hosts
    if (!hosts) {
      return
    }
    const fences = new Map(
      hosts.list().environments.map((environment) => [environment.id, relayHostFence(environment)])
    )
    for (const [environmentId, entry] of this.servers) {
      if (fences.get(environmentId) !== entry.fence) {
        this.drop(entry)
        this.servers.delete(environmentId)
        this.revision.bump()
      }
    }
    // Why the shown hosts: a managed server reached over its SSH host's relay is not in contact here.
    const shown = new Map(describeRelayHosts(hosts).map((host) => [host.environmentId, host]))
    for (const host of shown.values()) {
      if (!this.servers.has(host.environmentId)) {
        this.servers.set(
          host.environmentId,
          newPairedServerEntry(host, {
            read: (entry) =>
              void this.fetch(hosts, entry).finally(() => {
                entry.gate.readSettled()
                this.settleReaders(entry)
              }),
            watching: () => this.options.hasDemand(),
            connected: (entry) => this.reachable(entry)
          })
        )
        this.revision.bump()
      }
    }
    for (const entry of this.servers.values()) {
      const inContact = shown.get(entry.environmentId)?.health === 'available'
      if (inContact !== entry.inContact) {
        entry.inContact = inContact
        entry.contactGeneration += 1
        entry.confirmed = false
        entry.catalogStale ||= inContact
        // A reconnect starts from a full read.
        entry.delta = null
        this.revision.bump()
      }
      // Why current(): a replaced transport can end the stream without telling it.
      if (inContact && !entry.watch?.current()) {
        entry.watch?.close()
        this.watch(hosts, entry)
      } else if (!inContact && entry.watch) {
        entry.watch.close()
        entry.watch = null
      }
      if (!inContact) {
        this.settleReaders(entry)
      }
    }
  }

  /** A reader's own read: settles after the gate's next read of the server, at most a floor away. */
  refresh(environmentId: string): Promise<void> {
    const entry = this.servers.get(environmentId)
    if (!entry) {
      return Promise.resolve()
    }
    entry.gate.polled()
    const settled = new Promise<void>((resolve) => entry.waiters.push(resolve))
    this.settleReaders(entry)
    return settled
  }

  /** The server's raw rows as last fetched under this pairing; null when none were. */
  rows(environmentId: string, fence: string): readonly MobileRelayServerWorktreeRow[] | null {
    const entry = this.servers.get(environmentId)
    if (!entry || entry.fence !== fence) {
      return null
    }
    entry.gate.watched()
    return entry.rows
  }

  snapshot(): PairedServerRowsSnapshot {
    for (const entry of this.servers.values()) {
      entry.gate.watched()
    }
    const shown = new Map(
      (this.hosts
        ? describePairedServerHosts({
            ...this.hosts.list(),
            hostLabelOverrides: this.options.hostLabelOverrides()
          })
        : []
      ).map(({ environmentId, label, health, compatibility, pairedDeviceId, installationId }) => [
        environmentId,
        {
          label,
          health,
          compatibility,
          pairedDeviceId,
          ...(installationId ? { installationId } : {})
        }
      ])
    )
    return {
      revision: this.revision.value,
      servers: [...this.servers.values()].map((entry) => {
        const hostId = toRuntimeExecutionHostId(entry.environmentId)
        return {
          hostId,
          freshness: entry.inContact && entry.confirmed ? 'live' : 'unverifiable',
          host: shown.get(entry.environmentId) ?? null,
          rows: (entry.rows ?? []).flatMap((row) => normalizePairedServerRow(hostId, row) ?? [])
        }
      })
    }
  }

  /** Each server's catalog as last fetched, kept like its rows while it is out of contact. */
  catalogs(): PairedServerCatalog[] {
    return [...this.servers.values()].flatMap((entry) => entry.catalog ?? [])
  }

  private watch(hosts: MobileDesktopRelayHosts, entry: PairedServerEntry): void {
    const current = (): boolean => this.servers.get(entry.environmentId) === entry
    // Ready fires on every (re)connect, so contact and a missed-event replay both count as changes.
    const watch = hosts.watchChanges({ environmentId: entry.environmentId }, entry.identity, {
      onChange: ({ catalog, live }) => {
        if (!current()) {
          return
        }
        entry.catalogStale ||= catalog
        if (live) {
          entry.gate.live()
        } else {
          entry.gate.changed()
        }
      },
      onClose: () => {
        if (current() && entry.watch === watch) {
          entry.watch = null
        }
      }
    })
    entry.watch = watch
  }

  private drop(entry: PairedServerEntry): void {
    entry.watch?.close()
    entry.gate.dispose()
    if (!entry.gate.reading) {
      wakePairedServerReaders(entry)
    }
  }

  private reachable(entry: PairedServerEntry): boolean {
    return entry.inContact && this.servers.get(entry.environmentId) === entry
  }

  // Readers wait for the read the gate holds; once none will run, they take the rows last answered.
  private settleReaders(entry: PairedServerEntry): void {
    if (!entry.gate.reading && (entry.gate.current || !this.reachable(entry))) {
      wakePairedServerReaders(entry)
    }
  }

  private unconfirm(entry: PairedServerEntry): void {
    if (entry.confirmed) {
      entry.confirmed = false
      this.revision.bump()
    }
  }

  private async fetch(hosts: MobileDesktopRelayHosts, entry: PairedServerEntry): Promise<void> {
    const { contactGeneration } = entry
    const call = async (method: string, params?: unknown) =>
      hosts.call({ environmentId: entry.environmentId }, method, params, {
        // Readers consume cached rows, so use the normal transport deadline to accept slow answers while bounding hung calls.
        expected: entry.identity
      })
    // Only on contact, ready, a replay or reposChanged, which every catalog write announces.
    const readCatalog = entry.catalogStale
    entry.catalogStale = false
    const held = entry.delta
    const [read, catalog] = await Promise.all([
      readServerWorktreeRows(call, held),
      readCatalog
        ? fetchPairedServerCatalog(entry.environmentId, call, entry.catalog).catch(() => null)
        : null
    ])
    // Discard replies from pairings replaced or removed while fetching.
    if (this.servers.get(entry.environmentId) !== entry) {
      return
    }
    if (catalog) {
      entry.catalog = catalog
      this.revision.bump()
    } else if (readCatalog) {
      entry.catalogStale = true
    }
    if (!read?.ok) {
      // A reply no rows can be built from re-reads in full; an unreachable server keeps its base.
      if (read) {
        entry.delta = null
      }
      this.unconfirm(entry)
      return
    }
    // An answer from before a contact gap may keep its rows, but cannot vouch for them now.
    const confirmed = entry.inContact && entry.contactGeneration === contactGeneration
    // An unchanged reply hands back the held snapshot itself.
    const rowsChanged = read.snapshot !== held
    // A reply from before a contact gap must not restore the base the reconnect dropped.
    if (entry.contactGeneration === contactGeneration) {
      entry.delta = read.snapshot
    }
    if (rowsChanged) {
      entry.rows = stampServerWorktreeRows(entry.environmentId, read.snapshot.worktrees)
    } else if (confirmed === entry.confirmed) {
      return
    }
    entry.confirmed = confirmed
    this.revision.bump()
  }
}
