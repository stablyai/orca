import { fingerprintOrchestrationPeer } from '../../runtime/orchestration/environment-transport'
import type { OrchestrationEnvironmentTransport } from '../../runtime/orchestration/environment-transport'
import { getPreferredPairedRuntimeConnection } from '../../../shared/runtime-environments'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

/**
 * Dial paired runtime environments for cross-server orchestration (worker dispatch on a
 * connected server). The pairing registry and the request path are host-free; every
 * main-process runtime wires this, desktop and headless serve alike (#36853). The root is
 * read per call: the desktop resolves it only after `app.setName` settles the casing.
 */
export function createOrchestrationEnvironmentTransport(
  registryRoot: string | (() => string)
): OrchestrationEnvironmentTransport {
  const root = typeof registryRoot === 'function' ? registryRoot : () => registryRoot
  return {
    resolve: (selector) => {
      const environment = resolveEnvironment(root(), selector)
      const connection = getPreferredPairedRuntimeConnection(environment)
      return {
        environmentId: environment.id,
        name: environment.name,
        peerFingerprint: fingerprintOrchestrationPeer(connection.hostPublicKeyB64),
        pairingRevision: environment.pairingRevision ?? environment.createdAt
      }
    },
    call: (selector, method, params, timeoutMs, envelope, expectedPairingRevision) =>
      callRuntimeEnvironment(
        root(),
        selector,
        method,
        params,
        timeoutMs,
        expectedPairingRevision,
        envelope
      )
  }
}
