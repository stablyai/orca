import { describePairedServerHosts } from '../../../../shared/remote-runtime/host-catalog/paired-server-hosts'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  normalizePairedServerRow,
  type PairedServerRowsSnapshot
} from '../../../../shared/sidebar-list/feed-facts/paired-server-rows'
import type { MobileDesktopRelayListing } from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import type { ServerEntry } from './paired-server-rows-state'
export function pairedServerRowsSnapshot(
  listing: MobileDesktopRelayListing | null,
  servers: Iterable<ServerEntry>,
  revision: number,
  hostLabelOverrides: ReadonlyMap<ExecutionHostId, string>
): PairedServerRowsSnapshot {
  const shown = new Map(
    (listing
      ? describePairedServerHosts({
          ...listing,
          hostLabelOverrides: hostLabelOverrides
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
    revision: revision,
    servers: [...servers].map((entry) => {
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
