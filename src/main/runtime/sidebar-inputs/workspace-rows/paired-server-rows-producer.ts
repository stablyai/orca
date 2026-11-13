import { observeEnvironmentStoreReads } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-read-observation'
import { newPairedServerEntry, type ServerEntry } from './paired-server-rows-state'
import { pairedServerRowsSnapshot } from './paired-server-rows-snapshot'
import { watchPairedServerRows } from './paired-server-rows-watch'
import { ProducerRevision } from '../producer-revision'
import { environmentStoreWriteCount } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { describePairedServerHosts } from '../../../../shared/remote-runtime/host-catalog/paired-server-hosts'
import type { MobileRelayServerWorktreeRow } from '../../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { PairedServerRowsSnapshot } from '../../../../shared/sidebar-list/feed-facts/paired-server-rows'
import type {
  MobileDesktopRelayListing,
  MobileDesktopRelayHosts
} from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import {
  describeRelayHostListing,
  relayHostFence
} from '../../mobile-desktop-relay/mobile-relay-host-descriptions'
import type { ServerWorktreeRows } from '../../mobile-desktop-relay/mobile-relay-host-catalog'
import {
  SERVER_WORKTREE_LIMIT,
  WorktreePsReplySchema,
  stampServerWorktreeRows
} from '../../mobile-desktop-relay/server-worktree-fetch'
import type { PairedServerCatalog } from '../../../../shared/sidebar-list/catalog/sidebar-project-catalog'
import { fetchPairedServerCatalog } from '../../../../shared/sidebar-list/catalog/paired-server-catalog'

// Owner-approved fallback for changes a server announces no event for (status-only, older servers).
export const FALLBACK_REFRESH_MS = 30_000

/** Cache paired-server rows without a window; refresh on contact/events/reads and every 30s while visible. Contact gaps make rows unverifiable until a post-gap fetch; only removal/re-pair drops them. */
export class PairedServerRowsProducer implements ServerWorktreeRows {
  private readonly servers = new Map<string, ServerEntry>()
  private hosts: MobileDesktopRelayHosts | null = null
  private attachment: object | null = null
  private sourceGeneration = 0
  private detachHosts: (() => void) | null = null
  private refreshListing: Promise<void> | null = null
  private listingDirty = false
  private displayedHosts = ''
  readonly revision = new ProducerRevision()

  constructor(
    private readonly options: {
      hasDemand: () => boolean
      hostLabelOverrides: () => ReadonlyMap<ExecutionHostId, string>
    }
  ) {}

  attach(hosts: MobileDesktopRelayHosts): () => void {
    this.detachHosts?.()
    const attachment = {}
    this.attachment = attachment
    this.hosts = hosts
    const changed = (): void => {
      if (this.attachment !== attachment) {
        return
      }
      this.listingDirty = true
      this.refreshListing ??= this.refreshInvalidatedListing().finally(() => {
        this.refreshListing = null
      })
      void this.refreshListing.catch((error: unknown) =>
        console.warn('[paired-server-rows] could not list servers', error)
      )
    }
    const stopStatus = hosts.onStatusChanged((contact) => {
      if (this.attachment !== attachment) {
        return
      }
      const entry = contact ? this.servers.get(contact.environmentId) : undefined
      if (entry && contact && !contact.inContact && entry.inContact) {
        this.sourceGeneration++
        entry.inContact = false
        entry.contactGeneration++
        this.unconfirm(entry)
      }
      changed()
    })
    const stopRetired = hosts.onEnvironmentRetired((environmentId) => {
      if (this.attachment !== attachment) {
        return
      }
      const entry = this.servers.get(environmentId)
      if (entry) {
        this.sourceGeneration++
        this.retire(entry)
      }
      changed()
    })
    const stopCatalog = hosts.onCatalogChanged?.(changed)
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
    const detach = (): void => {
      if (this.attachment !== attachment) {
        return
      }
      this.attachment = null
      this.hosts = null
      this.detachHosts = null
      this.sourceGeneration++
      clearInterval(fallback)
      stopStatus()
      stopRetired()
      stopCatalog?.()
      for (const entry of this.servers.values()) {
        this.retire(entry)
      }
      this.displayedHosts = ''
      this.revision.bump()
    }
    this.detachHosts = detach
    changed()
    return detach
  }

  async sync(): Promise<void> {
    await this.withPreparedListing(() => {})
  }

  async snapshot(): Promise<PairedServerRowsSnapshot> {
    return this.withPreparedSnapshot((snapshot) => snapshot)
  }

  /** Keeps fresh host facts and their complete synchronous consumption in one continuation. */
  async withPreparedSnapshot<T>(consume: (snapshot: PairedServerRowsSnapshot) => T): Promise<T> {
    return this.withPreparedListing((listing) => consume(this.snapshotFromListing(listing)))
  }

  private async refreshInvalidatedListing(): Promise<void> {
    do {
      this.listingDirty = false
      await this.withPreparedListing(() => {})
    } while (this.listingDirty && this.hosts)
  }

  private async withPreparedListing<T>(
    consume: (listing: MobileDesktopRelayListing | null) => T
  ): Promise<T> {
    for (;;) {
      const hosts = this.hosts
      const attachment = this.attachment
      if (!hosts) {
        return consume(null)
      }
      const generation = this.sourceGeneration
      const observation = await observeEnvironmentStoreReads(
        async () => hosts.list(),
        environmentStoreWriteCount
      )
      if (
        attachment !== this.attachment ||
        generation !== this.sourceGeneration ||
        !observation.current
      ) {
        continue
      }
      this.syncListing(hosts, observation.value)
      return consume(observation.value)
    }
  }

  private retire(entry: ServerEntry): void {
    this.servers.delete(entry.environmentId)
    entry.watchSetup = null
    entry.watch?.close()
    this.revision.bump()
  }

  private syncListing(hosts: MobileDesktopRelayHosts, listing: MobileDesktopRelayListing): void {
    const fences = new Map(
      listing.environments.map((environment) => [environment.id, relayHostFence(environment)])
    )
    for (const [environmentId, entry] of this.servers) {
      if (fences.get(environmentId) !== entry.fence) {
        this.retire(entry)
      }
    }
    const shown = new Map(
      describeRelayHostListing(listing).map((host) => [host.environmentId, host])
    )
    const displayed = JSON.stringify(
      describePairedServerHosts({
        ...listing,
        hostLabelOverrides: this.options.hostLabelOverrides()
      })
    )
    if (displayed !== this.displayedHosts) {
      this.displayedHosts = displayed
      this.revision.bump()
    }
    for (const host of shown.values()) {
      if (!this.servers.has(host.environmentId)) {
        this.servers.set(
          host.environmentId,
          newPairedServerEntry(host.environmentId, relayHostFence(host.identity), host.identity)
        )
        this.revision.bump()
      }
    }
    for (const entry of this.servers.values()) {
      const inContact = shown.get(entry.environmentId)?.health === 'available'
      if (inContact !== entry.inContact) {
        entry.inContact = inContact
        entry.contactGeneration++
        entry.confirmed = false
        entry.catalogStale ||= inContact
        this.revision.bump()
        if (inContact && entry.rows !== null) {
          entry.refreshAgain ||= entry.refreshing !== null
          void this.refresh(entry.environmentId)
        }
      }
      if (inContact && !entry.watch?.current() && !entry.watchSetup) {
        entry.watch?.close()
        entry.watch = null
        watchPairedServerRows(hosts, entry, {
          attachment: () => this.attachment,
          current: (candidate) => this.servers.get(candidate.environmentId) === candidate,
          refresh: (id) => this.refresh(id)
        })
      } else if (!inContact) {
        entry.watchSetup = null
        entry.watch?.close()
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

  private snapshotFromListing(listing: MobileDesktopRelayListing | null): PairedServerRowsSnapshot {
    return pairedServerRowsSnapshot(
      listing,
      this.servers.values(),
      this.revision.value,
      this.options.hostLabelOverrides()
    )
  }

  /** Each server's catalog as last fetched, kept like its rows while it is out of contact. */
  catalogs(): PairedServerCatalog[] {
    return [...this.servers.values()].flatMap((entry) => entry.catalog ?? [])
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
