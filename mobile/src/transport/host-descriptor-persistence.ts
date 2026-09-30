import { mutateStoredHosts } from './host-list-mutation-queue'
import { withReportedDescriptor, type ReportedHostDescriptor } from './host-name-identity'

/**
 * Records what the desktop reported over an authenticated status read. Best-effort: descriptor
 * upkeep must never gate connecting or acting on a host. A reply carrying neither field (a desktop
 * from before either existed) writes nothing, so "Host N" rows for old desktops never churn.
 */
export async function updateHostDescriptor(
  hostId: string,
  descriptor: ReportedHostDescriptor
): Promise<void> {
  if (descriptor.machineName === null && descriptor.platform === null) {
    return
  }
  try {
    await mutateStoredHosts((hosts) => {
      const index = hosts.findIndex((host) => host.id === hostId)
      const updated = index === -1 ? null : withReportedDescriptor(hosts[index]!, descriptor)
      if (updated === null || updated === hosts[index]) {
        return hosts
      }
      const next = hosts.slice()
      next[index] = updated
      return next
    })
  } catch {
    // Unreadable storage is the next read's problem, not this bookkeeping's.
  }
}
