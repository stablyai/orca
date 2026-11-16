import {
  autologonPhase,
  keepAwakePhase,
  networkExposurePhase,
  tailscalePhase
} from './zotz-node-setup-common-phases'
import type { ZotzNodeSetupEnvironment } from './zotz-node-setup-environment'
import type { ZotzNodeSetupPhase } from './zotz-node-setup-orchestrator'
import {
  linuxFirewallPhase,
  macFirewallPhase,
  macPowerPhase,
  posixAutostartPhase
} from './zotz-node-setup-posix'
import { windowsElevatedPhase } from './zotz-node-setup-windows'

/** Order matters: Tailscale first (its address is the link), exposure after the firewall. */
export function buildZotzNodeSetupPhases(
  environment: ZotzNodeSetupEnvironment
): ZotzNodeSetupPhase[] {
  const platformPhases =
    environment.platform === 'win32'
      ? [windowsElevatedPhase(environment)]
      : environment.platform === 'darwin'
        ? [macPowerPhase(environment), macFirewallPhase(), posixAutostartPhase(environment)]
        : [linuxFirewallPhase(environment), posixAutostartPhase(environment)]
  return [
    tailscalePhase(environment),
    ...platformPhases,
    keepAwakePhase(environment),
    networkExposurePhase(environment),
    ...(environment.platform === 'win32' ? [autologonPhase()] : [])
  ]
}
