import { supportsMobileExistingAgentLaunch } from './mobile-existing-agent-launch'

/**
 * Whether an AI button that starts an agent with a prompt can be used on this host. There is no
 * older-host fallback: the path before `agent.launch` typed the prompt into a bare shell.
 * `unverified`: the host's status could not be read, so whether it is too old is unknown.
 */
export type MobileAgentLaunchAvailability =
  | 'checking'
  | 'available'
  | 'update-required'
  | 'unverified'

/** The host status gates this reads (`useHostProtocolGates`). */
export type MobileAgentLaunchHostStatus = {
  hostCapabilities: readonly string[]
  statusPending: boolean
  statusReadable: boolean
}

export function resolveMobileAgentLaunchAvailability(
  host: MobileAgentLaunchHostStatus
): MobileAgentLaunchAvailability {
  if (supportsMobileExistingAgentLaunch(host.hostCapabilities)) {
    return 'available'
  }
  if (host.statusPending) {
    return 'checking'
  }
  // Only a host that answered without the capability is too old to update.
  return host.statusReadable ? 'update-required' : 'unverified'
}
