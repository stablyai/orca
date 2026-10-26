import { mutateStoredHosts } from './host-list-mutation-queue'
import { withReportedDescriptor, type ReportedHostDescriptor } from './host-name-identity'

// Keep authenticated descriptor upkeep best-effort; older hosts omitting both fields must not churn stored rows.
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
