import type { HostStatusGates } from './host-status-gates'
import type { HostStatusReply } from './host-status-reply-schema'

/** The status fields a proven gate came from, for a page that would otherwise ask again; null while unproven. */
export function provenHostStatus(gates: HostStatusGates): HostStatusReply | null {
  if (gates.statusPending || !gates.statusReadable) {
    return null
  }
  return {
    protocolVersion: gates.hostProtocolWindow.protocolVersion,
    minCompatibleMobileVersion: gates.hostProtocolWindow.minCompatibleMobileVersion,
    capabilities: gates.hostCapabilities,
    floatingWorkspaceEnabled: gates.floatingWorkspaceEnabled,
    ...(gates.desktopAppVersion ? { appVersion: gates.desktopAppVersion } : {})
  }
}
