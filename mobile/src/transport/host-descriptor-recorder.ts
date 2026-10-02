import { recordHostDescriptor } from './host-descriptor-store'
import { updateHostDescriptor } from './host-store'
import type { HostStatusReply } from './host-status-reply-schema'

/**
 * The one writer of host descriptor state. Every readable status reply that arrives with a known
 * host id lands here: the in-memory store repaints connected rows immediately, and the persisted
 * copy is what an offline or freshly restarted app shows as "Last known". Persistence is
 * best-effort inside `updateHostDescriptor`; recording must never gate a connection.
 */
export function recordHostDescriptorFromStatus(hostId: string, status: HostStatusReply): void {
  const descriptor = {
    machineName: status.machineName?.trim() || null,
    platform: status.hostPlatform ?? null
  }
  recordHostDescriptor(hostId, descriptor)
  void updateHostDescriptor(hostId, descriptor)
}
