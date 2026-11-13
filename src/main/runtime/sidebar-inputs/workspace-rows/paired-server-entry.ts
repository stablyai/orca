import {
  HostReadGate,
  HOST_READ_FLOOR_MS
} from '../../../../shared/remote-runtime/host-change-read-gate'
import type { MobileRelayServerWorktreeRow } from '../../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { PairedServerCatalog } from '../../../../shared/sidebar-list/sidebar-project-catalog'
import type { WorktreeCatalogSnapshot } from '../../../../shared/worktree/catalog-row-delta'
import type {
  MobileDesktopRelayHostListing,
  MobileDesktopRelayHostWatch
} from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import { relayHostFence } from '../../mobile-desktop-relay/mobile-relay-host-descriptions'
import type { ServerWorktreeRow } from '../../mobile-desktop-relay/server-worktree-fetch'

export type PairedServerEntry = {
  environmentId: string
  fence: string
  identity: Pick<MobileDesktopRelayHostListing, 'pairingRevision' | 'runtimeId'>
  inContact: boolean
  /** Moves on every contact change, so an answer can tell it predates a gap. */
  contactGeneration: number
  /** Null until a fetch under this pairing answered. */
  rows: MobileRelayServerWorktreeRow[] | null
  /** The server's rows under its snapshot id, the base of the next delta read; null asks in full. */
  delta: WorktreeCatalogSnapshot<ServerWorktreeRow> | null
  /** The rows are the server's answer since it last came into contact; else unverifiable. */
  confirmed: boolean
  /** Its repos and project groups as last fetched under this pairing; null until one answered. */
  catalog: PairedServerCatalog | null
  /** A catalog change may have gone unread: set on contact and on a catalog change event. */
  catalogStale: boolean
  watch: MobileDesktopRelayHostWatch | null
  /** Every read of this server goes through it: events, the backstop, reconnects and consumer reads. */
  gate: HostReadGate
  /** Consumers waiting for the read the gate holds or has out. */
  waiters: (() => void)[]
}

/** A server first seen under this pairing: out of contact, nothing read yet. */
export function newPairedServerEntry(
  host: { environmentId: string; identity: PairedServerEntry['identity'] },
  reads: {
    read: (entry: PairedServerEntry) => void
    watching: () => boolean
    connected: (entry: PairedServerEntry) => boolean
  }
): PairedServerEntry {
  const entry: PairedServerEntry = {
    environmentId: host.environmentId,
    fence: relayHostFence(host.identity),
    identity: host.identity,
    inContact: false,
    contactGeneration: 0,
    rows: null,
    delta: null,
    confirmed: false,
    catalog: null,
    catalogStale: true,
    watch: null,
    waiters: [],
    gate: new HostReadGate({
      floorMs: HOST_READ_FLOOR_MS,
      read: () => reads.read(entry),
      watching: reads.watching,
      connected: () => reads.connected(entry)
    })
  }
  return entry
}

export function wakePairedServerReaders(entry: PairedServerEntry): void {
  for (const resolve of entry.waiters.splice(0)) {
    resolve()
  }
}
