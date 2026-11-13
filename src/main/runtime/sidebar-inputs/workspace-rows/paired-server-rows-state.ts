import type { MobileRelayServerWorktreeRow } from '../../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type {
  MobileDesktopRelayHostListing,
  MobileDesktopRelayHostWatch
} from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import type { PairedServerCatalog } from '../../../../shared/sidebar-list/catalog/sidebar-project-catalog'
export type ServerEntry = {
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
  watchSetup: object | null
  refreshing: Promise<void> | null
  refreshAgain: boolean
}

export function newPairedServerEntry(
  environmentId: string,
  fence: string,
  identity: ServerEntry['identity']
): ServerEntry {
  return {
    environmentId,
    fence,
    identity,
    inContact: false,
    contactGeneration: 0,
    rows: null,
    confirmed: false,
    catalog: null,
    catalogStale: true,
    watch: null,
    watchSetup: null,
    refreshing: null,
    refreshAgain: false
  }
}
