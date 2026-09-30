import { wslHookRelayManager } from '../../../agent-hooks/wsl-hook-relay-manager'
import type { PiAgentKind } from '../../../../shared/pi-agent-kind'

export function applyWslGuestAgentSourceEnv(
  baseEnv: Record<string, string>,
  distro: string | null,
  kind: PiAgentKind | null
): void {
  if (kind === 'pi') {
    const guestPiDir = wslHookRelayManager.getGuestAgentPath(distro, 'pi')
    if (guestPiDir) {
      baseEnv.ORCA_PI_SOURCE_AGENT_DIR = guestPiDir
    }
    return
  }
  if (kind === 'omp') {
    const guestOmpExtension = wslHookRelayManager.getGuestAgentPath(distro, 'omp')
    if (guestOmpExtension) {
      baseEnv.ORCA_OMP_STATUS_EXTENSION = guestOmpExtension
    }
    return
  }
  if (kind === 'omo') {
    const guestOmoDir = wslHookRelayManager.getGuestAgentPath(distro, 'omo')
    if (guestOmoDir) {
      baseEnv.ORCA_OMO_SOURCE_AGENT_DIR = guestOmoDir
    }
  }
}
