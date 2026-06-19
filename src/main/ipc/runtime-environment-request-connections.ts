import type { PairingOffer } from '../../shared/pairing'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { RemoteRuntimeSharedControlConnection } from '../../shared/remote-runtime-shared-control-connection'
import type {
  RemoteRuntimeSharedConnectionDiagnostics,
  RemoteRuntimeSharedSubscription
} from '../../shared/remote-runtime-shared-control-types'

type CachedRuntimeConnection = {
  pairingKey: string
  connection: RemoteRuntimeRequestConnection
}

type CachedSharedControlConnection = {
  pairingKey: string
  connection: RemoteRuntimeSharedControlConnection
}

const requestConnections = new Map<string, CachedRuntimeConnection>()
const sharedControlConnections = new Map<string, CachedSharedControlConnection>()

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
  closeRemoteRuntimeSharedControlConnection(environmentId)
}

export function closeAllRemoteRuntimeRequestConnections(): void {
  for (const environmentId of Array.from(requestConnections.keys())) {
    closeRemoteRuntimeRequestConnection(environmentId)
  }
  for (const environmentId of Array.from(sharedControlConnections.keys())) {
    closeRemoteRuntimeSharedControlConnection(environmentId)
  }
}

export function sendRemoteRuntimeSharedControlRequest<TResult>(
  environmentId: string,
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<RuntimeRpcResponse<TResult>> {
  return getSharedControlConnection(environmentId, pairing).request(method, params, timeoutMs)
}

export function subscribeRemoteRuntimeSharedControlRequest<TResult>(
  environmentId: string,
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: {
    onResponse: (response: RuntimeRpcResponse<TResult>) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError: (error: { code: string; message: string }) => void
    onClose?: () => void
  }
): Promise<RemoteRuntimeSharedSubscription> {
  return getSharedControlConnection(environmentId, pairing).subscribe(
    method,
    params,
    timeoutMs,
    callbacks
  )
}

export function closeRemoteRuntimeSharedControlConnection(environmentId: string): void {
  const cached = sharedControlConnections.get(environmentId)
  sharedControlConnections.delete(environmentId)
  cached?.connection.close()
}

export function getRemoteRuntimeSharedControlDiagnostics(
  environmentId: string
): RemoteRuntimeSharedConnectionDiagnostics | null {
  return sharedControlConnections.get(environmentId)?.connection.getDiagnostics() ?? null
}

function getSharedControlConnection(
  environmentId: string,
  pairing: PairingOffer
): RemoteRuntimeSharedControlConnection {
  const pairingKey = getPairingKey(pairing)
  let cached = sharedControlConnections.get(environmentId)
  if (!cached || cached.pairingKey !== pairingKey) {
    cached?.connection.close()
    cached = {
      pairingKey,
      connection: new RemoteRuntimeSharedControlConnection(pairing, { environmentId })
    }
    sharedControlConnections.set(environmentId, cached)
  }
  return cached.connection
}

function getPairingKey(pairing: PairingOffer): string {
  return [pairing.endpoint, pairing.deviceToken, pairing.publicKeyB64].join('\0')
}
