export {
  getRuntimeEnvironmentStatusOwner,
  withRuntimeEnvironmentStatusOwner,
  resetRuntimeEnvironmentStatusOwners,
  getRuntimeEnvironmentStatusSnapshot,
  getRuntimeEnvironmentStatusSnapshots
} from '../status/runtime-environment-status-owner-registry'
import {
  getOwnedRuntimeEnvironmentStatusOwner,
  retireRuntimeEnvironmentStatusOwner
} from '../status/runtime-environment-status-owner-registry'

export { isRemoteRuntimeConnectionReady } from './runtime-environment-connection-readiness'
import { runtimeEnvironmentConnectionPairingKey as getPairingKey } from './runtime-environment-capability-evidence'
import type { RuntimeEnvironmentCall } from '../requests/runtime-environment-call'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'

import type { RuntimeStatus } from '../../../../shared/runtime-session-contracts'

import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRequestGuard,
  RuntimeRequestPreparation,
  RuntimeRpcResponse
} from '../../../../shared/runtime-rpc-envelope'
import { RemoteRuntimeRequestConnection } from '../../../../shared/remote-runtime/requests/remote-runtime-request-connection'
import { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import { probeAllRemoteRuntimeSocketsNow } from '../../../../shared/remote-runtime/remote-runtime-socket-liveness'
import type {
  RemoteRuntimeSharedConnectionDiagnostics,
  RemoteRuntimeSharedSubscription
} from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { isRuntimeEnvironmentManuallyDisconnected } from '../connectivity/runtime-environment-manual-disconnect'
import { publishRuntimeEnvironmentDiagnostics } from '../status/runtime-environment-diagnostics-broadcast'
import { sharedControlEnvironmentPolicy } from './runtime-environment-shared-control-policy'
import {
  clearSharedControlAnswerSource,
  setSharedControlAnswerSource
} from './runtime-environment-shared-control-answers'
import {
  advanceRuntimeEnvironmentTransportGeneration,
  getRuntimeEnvironmentTransportGeneration
} from './runtime-environment-transport-generation'
import { noteRuntimeEnvironmentSharedControlContact } from '../status/runtime-environment-contact-loss'
import { declareWslHostClient } from '../../../wsl/host-lifecycle/wsl-host-client-declaration'

type CachedRuntimeConnection = {
  pairingKey: string
  connection: RemoteRuntimeRequestConnection
}

type CachedSharedControlConnection = {
  pairingKey: string
  connection: RemoteRuntimeSharedControlConnection
  answeredAt: () => number | null
}

export const requestConnections = new Map<string, CachedRuntimeConnection>()
export const sharedControlConnections = new Map<string, CachedSharedControlConnection>()

export function sendRemoteRuntimeConnectionRequest<TResult>(
  environmentId: string,
  pairedConnection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<TResult>> {
  const pairingKey = getPairingKey(pairedConnection)
  let cached = requestConnections.get(environmentId)
  if (!cached || cached.pairingKey !== pairingKey) {
    cached?.connection.close()
    cached = {
      pairingKey,
      connection: new RemoteRuntimeRequestConnection(
        pairedConnection,
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      )
    }
    requestConnections.set(environmentId, cached)
  }
  return cached.connection.request(method, params, timeoutMs, signal)
}

export function closeRemoteRuntimeRequestConnection(environmentId: string): void {
  retireRuntimeEnvironmentStatusOwner(environmentId)
  const cached = requestConnections.get(environmentId)
  requestConnections.delete(environmentId)
  cached?.connection.close()
  closeRemoteRuntimeSharedControlConnection(environmentId)
}

export function sendRemoteRuntimeSharedControlRequest<TResult>(
  environmentId: string,
  pairedConnection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal,
  prepareRequest?: RuntimeRequestPreparation,
  prepareGuard?: RuntimeRequestGuard
): Promise<RuntimeRpcResponse<TResult>> {
  const connection = getSharedControlConnection(environmentId, pairedConnection)
  return connection.request(method, params, timeoutMs, envelope, signal, {
    prepareRequest,
    prepareGuard
  })
}

/** Send only on the shared socket that proved expectedRuntimeId; return null if it changed or is unproven. */
export async function sendRemoteRuntimeSharedControlRequestOnRuntime<TResult>(
  environmentId: string,
  pairedConnection: PairedRuntimeConnection,
  call: RuntimeEnvironmentCall,
  expectedRuntimeId: string
): Promise<RuntimeRpcResponse<TResult> | null> {
  const shared = getSharedControlConnection(environmentId, pairedConnection)
  let statusSocket: number | undefined
  const status = await shared.request<RuntimeStatus>(
    'status.get',
    undefined,
    call.timeoutMs,
    undefined,
    call.signal,
    { beforeSend: () => void (statusSocket = shared.socketGeneration.peek()) }
  )
  if (!status.ok || status.result.runtimeId !== expectedRuntimeId) {
    return null
  }
  let socketChanged = false
  const beforeSend = (): void => {
    socketChanged = shared.socketGeneration.peek() !== statusSocket
    if (socketChanged) {
      throw new Error('Runtime connection changed before sending')
    }
  }
  try {
    return await shared.request<TResult>(
      call.method,
      call.params,
      call.timeoutMs,
      call.envelope,
      call.signal,
      { beforeSend, prepareRequest: call.prepareRequest, prepareGuard: call.prepareGuard }
    )
  } catch (error) {
    if (socketChanged) {
      return null
    }
    throw error
  }
}

export function subscribeRemoteRuntimeSharedControlRequest<TResult>(
  environmentId: string,
  pairedConnection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  callbacks: {
    onResponse: (response: RuntimeRpcResponse<TResult>) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError: (error: { code: string; message: string }) => void
    onClose?: () => void
  },
  signal?: AbortSignal
): Promise<RemoteRuntimeSharedSubscription> {
  return getSharedControlConnection(environmentId, pairedConnection).subscribe(
    method,
    params,
    timeoutMs,
    callbacks,
    signal
  )
}

export function closeRemoteRuntimeSharedControlConnection(environmentId: string): void {
  const cached = sharedControlConnections.get(environmentId)
  sharedControlConnections.delete(environmentId)
  clearSharedControlAnswerSource(environmentId)
  cached?.connection.close()
}

export function getRemoteRuntimeSharedControlDiagnostics(
  environmentId: string
): RemoteRuntimeSharedConnectionDiagnostics | null {
  return sharedControlConnections.get(environmentId)?.connection.getDiagnostics() ?? null
}

export function reconnectRemoteRuntimeSharedControlConnection(environmentId: string): void {
  sharedControlConnections.get(environmentId)?.connection.reconnectNow()
}

export function pauseRemoteRuntimeSharedControlRetry(environmentId: string): void {
  sharedControlConnections.get(environmentId)?.connection.pauseStandingRetry()
}

export function ensureRemoteRuntimeSharedControlConnection(
  environmentId: string,
  pairedConnection: PairedRuntimeConnection
): void {
  if (!isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
    getSharedControlConnection(environmentId, pairedConnection)
  }
}

export function retryRemoteRuntimeSharedControlConnectionsNow(): void {
  for (const { connection } of sharedControlConnections.values()) {
    connection.retryNow()
  }
  // OPEN sockets can be dead after suspend with no reconnect timer; probe every socket (#9092).
  probeAllRemoteRuntimeSocketsNow()
}

function getSharedControlConnection(
  environmentId: string,
  pairedConnection: PairedRuntimeConnection
): RemoteRuntimeSharedControlConnection {
  const pairingKey = getPairingKey(pairedConnection)
  let cached = sharedControlConnections.get(environmentId)
  if (!cached || cached.pairingKey !== pairingKey) {
    advanceRuntimeEnvironmentTransportGeneration(environmentId)
    cached?.connection.close()
    const transportGeneration = getRuntimeEnvironmentTransportGeneration(environmentId)
    let answeredAt: number | null = null
    const connection: RemoteRuntimeSharedControlConnection =
      new RemoteRuntimeSharedControlConnection(pairedConnection, {
        environmentId,
        clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
        ...sharedControlEnvironmentPolicy(environmentId),
        // Ws pongs can come from a relay hop or a runtime whose request path is stuck (#39785).
        appHeartbeat: {},
        // R39: every ready socket, including after a reconnect, re-declares this installation.
        onReady: async () =>
          await declareWslHostClient(environmentId, (method, params, timeoutMs) =>
            connection.request(method, params, timeoutMs)
          ),
        // Wall-clock time includes suspend, expiring pre-sleep answers.
        onAnswered: () => {
          answeredAt = Date.now()
        },
        onDiagnosticsChanged: (diagnostics) => {
          if (getRuntimeEnvironmentTransportGeneration(environmentId) !== transportGeneration) {
            return
          }
          publishRuntimeEnvironmentDiagnostics({
            environmentId,
            transportGeneration,
            diagnostics
          })
          noteRuntimeEnvironmentSharedControlContact(environmentId, diagnostics)
          getOwnedRuntimeEnvironmentStatusOwner(environmentId)?.connectionChanged(
            diagnostics.state === 'ready'
              ? 'ready'
              : diagnostics.state === 'closed' || diagnostics.state === 'reconnecting'
                ? 'disconnected'
                : 'connecting',
            diagnostics
          )
        }
      })
    cached = { pairingKey, answeredAt: () => answeredAt, connection }
    sharedControlConnections.set(environmentId, cached)
    const entry = cached
    // Ready requires this socket's own server frame, which stamps its answer time.
    setSharedControlAnswerSource(environmentId, entry.connection, () =>
      entry.connection.getDiagnostics().state === 'ready' ? entry.answeredAt() : null
    )
  }
  return cached.connection
}
