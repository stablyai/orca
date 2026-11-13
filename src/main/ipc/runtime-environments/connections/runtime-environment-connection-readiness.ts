import {
  requestConnections,
  sharedControlConnections
} from './runtime-environment-request-connections'
import { runtimeEnvironmentConnectionPairingKey as getPairingKey } from './runtime-environment-capability-evidence'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'

/** Consult owned authenticated transports without acquiring another host channel. */
export function isRemoteRuntimeConnectionReady(
  environmentId: string,
  pairedConnection: PairedRuntimeConnection
): boolean {
  const pairingKey = getPairingKey(pairedConnection)
  return [sharedControlConnections.get(environmentId), requestConnections.get(environmentId)].some(
    (cached) => cached?.pairingKey === pairingKey && cached.connection.isReady()
  )
}
