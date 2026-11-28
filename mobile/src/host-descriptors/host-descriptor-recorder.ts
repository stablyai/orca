import { recordHostDescriptor } from './host-descriptor-store'
import { updateHostDescriptor } from './host-descriptor-persistence'
import { recordHostInstallation } from './direct-pairing-installations'
import type { HostStatusReply } from '../transport/hosts/host-status-reply-schema'

// Update live rows and persisted last-known descriptors together; best-effort bookkeeping must never gate connection.
export function recordHostDescriptorFromStatus(hostId: string, status: HostStatusReply): void {
  const descriptor = {
    machineName: status.machineName?.trim() || null,
    platform: status.hostPlatform ?? null,
    machine: status.hostMachine ?? null
  }
  recordHostDescriptor(hostId, descriptor)
  recordHostInstallation(hostId, status.hostDescriptor?.installationId ?? null)
  void updateHostDescriptor(hostId, descriptor)
}
