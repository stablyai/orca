import { getAppEnvironment } from '../../../../shared/app-environment'
import { getPreferredPairedRuntimeConnection } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  listEnvironments,
  resolveEnvironment
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  pairedOrchestrationPeers,
  type OrchestrationEnvironmentTransport
} from '../../../runtime/orchestration/federation/environment-transport'

/** Dials this host's paired servers for cross-server orchestration; host-free, so desktop and orcad share it. */
export function createOrchestrationEnvironmentTransport(): OrchestrationEnvironmentTransport {
  // Read per call: the desktop settles userData casing only after app.setName.
  const registryRoot = (): string => getAppEnvironment().getPath('userData')
  return {
    resolve: async (selector) => {
      const environment = await resolveEnvironment(registryRoot(), selector)
      const connection = getPreferredPairedRuntimeConnection(environment)
      return {
        environmentId: environment.id,
        name: environment.name,
        ...pairedOrchestrationPeers(connection.hostPublicKeyB64, connection.credential.deviceToken),
        pairingRevision: environment.pairingRevision ?? environment.createdAt
      }
    },
    hasEnvironment: async (environmentId) =>
      (await listEnvironments(registryRoot())).some(
        (environment) => environment.id === environmentId
      ),
    // Loaded on first dial: the routing graph is large and most hosts never place remote workers.
    call: async (selector, method, params, timeoutMs, envelope, expectedPairingRevision, send) =>
      (await import('./runtime-environment-transport-routing')).callRuntimeEnvironment(
        registryRoot(),
        selector,
        method,
        params,
        timeoutMs,
        expectedPairingRevision,
        envelope,
        send && {
          ...(send.prepareRequest ? { prepareRequest: send.prepareRequest } : {}),
          ...(send.prepareGuard ? { prepareGuard: send.prepareGuard } : {}),
          ...(send.expectedRuntimeId === undefined
            ? {}
            : { expectedEnvironmentRuntimeId: send.expectedRuntimeId })
        }
      )
  }
}
