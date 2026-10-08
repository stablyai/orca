import { app } from 'electron'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import type { MobileDesktopRelayHosts } from '../runtime/mobile-desktop-relay/mobile-desktop-relay-hosts'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

const retirementListeners = new Set<(environmentId: string) => void>()

/** Called wherever the desktop's own transport to a server is invalidated. */
export function retireMobileDesktopRelayEnvironment(environmentId: string): void {
  for (const listener of retirementListeners) {
    listener(environmentId)
  }
}

/** The desktop's configured servers, addressed only by exact environment id. */
export function createRuntimeEnvironmentMobileRelayHosts(): MobileDesktopRelayHosts {
  // Why userData: configured servers live where the runtime-environment handlers keep them.
  const userDataPath = app.getPath('userData')
  return {
    resolve: async (environmentId) => {
      if (!listEnvironments(userDataPath).some((entry) => entry.id === environmentId)) {
        return null
      }
      const environment = await resolveManagedRuntimeEnvironment(userDataPath, environmentId)
      return {
        environmentId,
        fence: `${environment.pairingRevision ?? environment.createdAt}\0${environment.runtimeId}`,
        pairing: getPreferredPairingOffer(environment)
      }
    },
    call: (host, method, params) =>
      callRuntimeEnvironment(userDataPath, host.environmentId, method, params),
    onEnvironmentRetired: (listener) => {
      retirementListeners.add(listener)
      return () => retirementListeners.delete(listener)
    }
  }
}
