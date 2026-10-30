import { supportsMobileExistingAgentLaunch } from './mobile-existing-agent-launch'

// No fallback may type prompts into bare shells; unverified status is not evidence the host needs an update.
export type MobileAgentLaunchAvailability =
  | 'checking'
  | 'available'
  | 'update-required'
  | 'unverified'

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
