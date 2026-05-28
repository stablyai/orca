import type { PairingOffer } from '../../shared/pairing'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'

type CachedRuntimeConnection = {
  pairingKey: string
  connection: RemoteRuntimeRequestConnection
}

const requestConnections = new Map<string, CachedRuntimeConnection>()

export function sendRemoteRuntimeConnectionRequest<TResult>(
  environmentId: string,
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<RuntimeRpcResponse<TResult>> {
  const pairingKey = getPairingKey(pairing)
  let cached = requestConnections.get(environmentId)
  if (!cached || cached.pairingKey !== pairingKey) {
    cached?.connection.close()
    cached = {
      pairingKey,
      connection: new RemoteRuntimeRequestConnection(pairing)
    }
    requestConnections.set(environmentId, cached)
  }
  return cached.connection.request(method, params, timeoutMs)
}

export function closeRemoteRuntimeRequestConnection(environmentId: string): void {
  const cached = requestConnections.get(environmentId)
  requestConnections.delete(environmentId)
  cached?.connection.close()
}

export function closeAllRemoteRuntimeRequestConnections(): void {
  for (const environmentId of Array.from(requestConnections.keys())) {
    closeRemoteRuntimeRequestConnection(environmentId)
  }
}

function getPairingKey(pairing: PairingOffer): string {
  return [pairing.endpoint, pairing.deviceToken, pairing.publicKeyB64].join('\0')
}
