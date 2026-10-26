import { ProducerRevision } from './producer-revision'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { describePairedServerHosts } from '../../../shared/paired-server-hosts'
import type { MobileRelayServerWorktreeRow } from '../../../shared/mobile-relay-hosts-contract'
import {
  normalizePairedServerRow,
  type PairedServerRowsSnapshot
} from '../../../shared/sidebar-list/paired-server-rows'
import type {
  MobileDesktopRelayHostListing,
  MobileDesktopRelayHosts,
  MobileDesktopRelayHostWatch
} from '../mobile-desktop-relay/mobile-desktop-relay-hosts'
import {
  describeRelayHosts,
  relayHostFence
} from '../mobile-desktop-relay/mobile-relay-host-descriptions'
import type { ServerWorktreeRows } from '../mobile-desktop-relay/mobile-relay-host-catalog'
import {
  SERVER_WORKTREE_LIMIT,
  WorktreePsReplySchema,
  stampServerWorktreeRows
} from '../mobile-desktop-relay/server-worktree-fetch'
import type { PairedServerCatalog } from '../../../shared/sidebar-list/sidebar-project-catalog'
import { fetchPairedServerCatalog } from '../../../shared/sidebar-list/paired-server-catalog'

// Owner-approved fallback for changes a server announces no event for (status-only, older servers).
export const FALLBACK_REFRESH_MS = 30_000

type ServerEntry = {
  environmentId: string
  fence: string
  identity: Pick<MobileDesktopRelayHostListing, 'pairingRevision' | 'runtimeId'>
  inContact: boolean
  /** Moves on every contact change, so an answer can tell it predates a gap. */
  contactGeneration: number
  /** Null until a fetch under this pairing answered. */
  rows: MobileRelayServerWorktreeRow[] | null
  /** The rows are the server's answer since it last came into contact; else unverifiable. */
  confirmed: boolean
  /** Its repos and project groups as last fetched under this pairing; null until one answered. */
  catalog: PairedServerCatalog | null
  /** A catalog change may have gone unread: set on contact and on a catalog change event. */
  catalogStale: boolean
  watch: MobileDesktopRelayHostWatch | null
  refreshing: Promise<void> | null
  refreshAgain: boolean
}

/** Cache paired-server rows without a window; refresh on contact/events/reads and every 30s while visible. Contact gaps make rows unverifiable until a post-gap fetch; only removal/re-pair drops them. */
export class PairedServerRowsProducer implements ServerWorktreeRows {
  private readonly servers = new Map<string, ServerEntry>()
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
    const fallback = setInterval(() => {
      if (this.options.hasDemand()) {
        for (const entry of this.servers.values()) {
          if (entry.inContact) {
            void this.refresh(entry.environmentId)
          }
        }
      }
    }, FALLBACK_REFRESH_MS)
    fallback.unref?.()
    this.sync()
    return () => {
      clearInterval(fallback)
      stopStatus()
      stopRetired()
      for (const entry of this.servers.values()) {
        entry.watch?.close()
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
        entry.watch?.close()
        this.servers.delete(environmentId)
        this.revision.bump()
      }
    }
    // Why the shown hosts: a managed server reached over its SSH host's relay is not in contact here.
    const shown = new Map(describeRelayHosts(hosts).map((host) => [host.environmentId, host]))
    for (const host of shown.values()) {
      if (!this.servers.has(host.environmentId)) {
        this.servers.set(host.environmentId, {
          environmentId: host.environmentId,
          fence: relayHostFence(host.identity),
          identity: host.identity,
          inContact: false,
          contactGeneration: 0,
          rows: null,
          confirmed: false,
          catalog: null,
          catalogStale: true,
          watch: null,
          refreshing: null,
          refreshAgain: false
        })
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
    }
  }

  /** Fetches now, or joins the fetch in flight. */
  refresh(environmentId: string): Promise<void> {
    const entry = this.servers.get(environmentId)
    if (!entry || !this.hosts) {
      return Promise.resolve()
    }
    if (!entry.refreshing) {
      const refreshing = this.fetchUntilCurrent(this.hosts, entry).finally(() => {
        entry.refreshing = null
      })
      entry.refreshing = refreshing
    }
    return entry.refreshing
  }

  /** The server's raw rows as last fetched under this pairing; null when none were. */
  rows(environmentId: string, fence: string): readonly MobileRelayServerWorktreeRow[] | null {
    const entry = this.servers.get(environmentId)
    return entry && entry.fence === fence ? entry.rows : null
  }

  snapshot(): PairedServerRowsSnapshot {
    const shown = new Map(
      (this.hosts
        ? describePairedServerHosts({
            ...this.hosts.list(),
            hostLabelOverrides: this.options.hostLabelOverrides()
          })
        : []
      ).map(({ environmentId, label, health, compatibility, pairedDeviceId }) => [
        environmentId,
        { label, health, compatibility, pairedDeviceId }
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

  private watch(hosts: MobileDesktopRelayHosts, entry: ServerEntry): void {
    const current = (): boolean => this.servers.get(entry.environmentId) === entry
    // Ready fires on every (re)connect, so contact and a missed-event replay both count as changes.
    const watch = hosts.watchChanges({ environmentId: entry.environmentId }, entry.identity, {
      onChange: ({ catalog }) => {
        if (current()) {
          // A fetch already in flight may predate this change, so one more runs after it.
          entry.refreshAgain ||= entry.refreshing !== null
          entry.catalogStale ||= catalog
          void this.refresh(entry.environmentId)
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

  private unconfirm(entry: ServerEntry): void {
    if (entry.confirmed) {
      entry.confirmed = false
      this.revision.bump()
    }
  }

  private async fetchUntilCurrent(hosts: MobileDesktopRelayHosts, entry: ServerEntry) {
    do {
      entry.refreshAgain = false
      await this.fetch(hosts, entry)
    } while (entry.refreshAgain && this.servers.get(entry.environmentId) === entry)
  }

  private async fetch(hosts: MobileDesktopRelayHosts, entry: ServerEntry): Promise<void> {
    const { contactGeneration } = entry
    const call = async (method: string, params?: unknown) =>
      hosts.call({ environmentId: entry.environmentId }, method, params, {
        // Readers consume cached rows, so use the normal transport deadline to accept slow answers while bounding hung calls.
        expected: entry.identity
      })
    // Only on contact, ready, a replay or reposChanged, which every catalog write announces.
    const readCatalog = entry.catalogStale
    entry.catalogStale = false
    const [response, catalog] = await Promise.all([
      call('worktree.ps', {
        limit: SERVER_WORKTREE_LIMIT,
        supportsWorktreeVisibilitySourceDefaults: true
      }).catch(() => null), // An unreachable server keeps its last rows.
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
    const reply = response?.ok ? WorktreePsReplySchema.safeParse(response.result) : null
    if (!reply?.success) {
      this.unconfirm(entry)
      return
    }
    entry.rows = stampServerWorktreeRows(entry.environmentId, reply.data.worktrees)
    // An answer from before a contact gap may keep its rows, but cannot vouch for them now.
    entry.confirmed = entry.inContact && entry.contactGeneration === contactGeneration
    // Every answer moves the revision: rows carry activity that changes without a catalog event.
    this.revision.bump()
  }
}
