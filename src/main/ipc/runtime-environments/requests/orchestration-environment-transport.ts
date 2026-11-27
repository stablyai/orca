import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { getPreferredPairedRuntimeConnection } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  listEnvironments,
  resolveEnvironment
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  pairedOrchestrationPeers,
  type OrchestrationEnvironmentTransport
} from '../../../runtime/orchestration/federation/environment-transport'
import { pairedRuntimeConnectionIdentity } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import {
  listSharedHostEnvironments,
  sharedHostEnvironmentNamed,
  sharedHostKey,
  sharedHostsReady
} from '../../../../shared/remote-runtime/pairing/shared-host-keys'

/** Dials this host's paired servers for cross-server orchestration, and the hosts of agents shared
 *  with this computer, which take mail as paired servers do; host-free, so desktop and orcad share it. */
export function createOrchestrationEnvironmentTransport(): OrchestrationEnvironmentTransport {
  // Read per call: the desktop settles userData casing only after app.setName.
  const registryRoot = (): string => getAppEnvironment().getPath('userData')
  // Every read waits for the kept shares to load, so a restart never reads a share as removed.
  const servers = async () => {
    await sharedHostsReady()
    return [...(await listEnvironments(registryRoot())), ...listSharedHostEnvironments()]
  }
  return {
    resolve: async (selector) => {
      await sharedHostsReady()
      // A shared host by id first, then a paired server by id or name, then a shared host by name.
      const environment = await resolveEnvironment(registryRoot(), selector).catch(
        (error: unknown) => sharedHostEnvironmentNamed(selector) ?? Promise.reject(error)
      )
      const connection = getPreferredPairedRuntimeConnection(environment)
      const share = sharedHostKey(environment.id) !== null
      return {
        environmentId: environment.id,
        name: environment.name,
        ...(share ? { sharedHost: true as const } : {}),
        ...pairedOrchestrationPeers(
          connection.hostPublicKeyB64,
          pairedRuntimeConnectionIdentity(connection),
          { share }
        ),
        pairingRevision: environment.pairingRevision ?? environment.createdAt
      }
    },
    list: async () =>
      (await servers()).map((environment) => ({
        environmentId: environment.id,
        name: environment.name
      })),
    hasEnvironment: async (environmentId) =>
      (await servers()).some((environment) => environment.id === environmentId),
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
