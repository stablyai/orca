import { recordHostDescriptor } from './host-descriptor-store'
import { updateHostDescriptor } from './host-store'
import type { HostStatusReply } from './host-status-reply-schema'

// Update live rows and persisted last-known descriptors together; best-effort bookkeeping must never gate connection.
export function recordHostDescriptorFromStatus(hostId: string, status: HostStatusReply): void {
  const descriptor = {
    machineName: status.machineName?.trim() || null,
    platform: status.hostPlatform ?? null
  }
  recordHostDescriptor(hostId, descriptor)
  void updateHostDescriptor(hostId, descriptor)
}
