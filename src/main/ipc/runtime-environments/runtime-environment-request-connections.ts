import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../../shared/runtime-environments'
import type { RuntimeHostStatusOwner } from '../../../shared/runtime-host-status-owner'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { createRuntimeEnvironmentStatusOwner } from './runtime-environment-status-owner'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'
import { RemoteRuntimeRequestConnection } from '../../../shared/remote-runtime-request-connection'
import { RemoteRuntimeSharedControlConnection } from '../../../shared/remote-runtime-shared-control-connection'
import { probeAllRemoteRuntimeSocketsNow } from '../../../shared/remote-runtime-socket-liveness'
import type {
  RemoteRuntimeSharedConnectionDiagnostics,
  RemoteRuntimeSharedSubscription
} from '../../../shared/remote-runtime-shared-control-types'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { publishRuntimeEnvironmentDiagnostics } from './runtime-environment-diagnostics-broadcast'
import { sharedControlEnvironmentPolicy } from './runtime-environment-shared-control-policy'
import {
  clearSharedControlAnswerSource,
  setSharedControlAnswerSource
} from './runtime-environment-shared-control-answers'
import {
  advanceRuntimeEnvironmentTransportGeneration,
  getRuntimeEnvironmentTransportGeneration
} from './runtime-environment-transport-generation'

type CachedRuntimeConnection = {
  pairingKey: string
  connection: RemoteRuntimeRequestConnection
}

type CachedSharedControlConnection = {
  pairingKey: string
  connection: RemoteRuntimeSharedControlConnection
  answeredAt: () => number | null
}

const requestConnections = new Map<string, CachedRuntimeConnection>()
const sharedControlConnections = new Map<string, CachedSharedControlConnection>()
const statusOwners = new Map<string, { key: string; owner: RuntimeHostStatusOwner }>()

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

export function getRuntimeEnvironmentStatusOwner(
  userDataPath: string,
  selector: string
): RuntimeHostStatusOwner {
  const environment = resolveEnvironment(userDataPath, selector)
  const pairedConnection = getPreferredPairedRuntimeConnection(environment)
  const key = `${userDataPath}\0${environment.pairingRevision ?? environment.createdAt}\0${getPairingKey(pairedConnection)}`
  let cached = statusOwners.get(environment.id)
  if (!cached || cached.key !== key || cached.owner.read().retired) {
    if (cached) {
      closeRemoteRuntimeRequestConnection(environment.id)
    }
    const owner = createRuntimeEnvironmentStatusOwner(userDataPath, environment, {
      isReady: () => getRemoteRuntimeSharedControlDiagnostics(environment.id)?.state === 'ready',
      request: (signal) =>
        sendRemoteRuntimeSharedControlRequest<RuntimeStatus>(
          environment.id,
          pairedConnection,
          'status.get',
          undefined,
          15_000,
          undefined,
          signal
        ),
      establish: () => {
        ensureRemoteRuntimeSharedControlConnection(environment.id, pairedConnection)
        reconnectRemoteRuntimeSharedControlConnection(environment.id)
      },
      pause: () => pauseRemoteRuntimeSharedControlRetry(environment.id)
    })
    cached = { key, owner }
    statusOwners.set(environment.id, cached)
    if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
      owner.dispose()
    }
  }
  return cached.owner
}

export function resetRuntimeEnvironmentStatusOwners(): void {
  for (const id of statusOwners.keys()) {
    closeRemoteRuntimeRequestConnection(id)
  }
}

export function getRuntimeEnvironmentStatusSnapshots() {
  return [...statusOwners.values()].map(({ owner }) => owner.read())
}

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
  const status = statusOwners.get(environmentId)
  statusOwners.delete(environmentId)
  status?.owner.dispose()
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
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<TResult>> {
  return getSharedControlConnection(environmentId, pairedConnection).request(
    method,
    params,
    timeoutMs,
    envelope,
    signal
  )
}

/**
 * Sends only on the shared socket whose own `status.get` named `expectedRuntimeId`; null when it
 * did not, or the socket changed before sending. Nothing is sent to another runtime either way.
 */
export async function sendRemoteRuntimeSharedControlRequestOnRuntime<TResult>(
  environmentId: string,
  pairedConnection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  expectedRuntimeId: string,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<TResult> | null> {
  const shared = getSharedControlConnection(environmentId, pairedConnection)
  let statusSocket: number | undefined
  const status = await shared.request<RuntimeStatus>(
    'status.get',
    undefined,
    timeoutMs,
    undefined,
    signal,
    () => {
      statusSocket = shared.socketGeneration.peek()
    }
  )
  if (!status.ok || status.result.runtimeId !== expectedRuntimeId) {
    return null
  }
  let socketChanged = false
  try {
    return await shared.request<TResult>(method, params, timeoutMs, envelope, signal, () => {
      socketChanged = shared.socketGeneration.peek() !== statusSocket
      if (socketChanged) {
        throw new Error('Runtime connection changed before sending')
      }
    })
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

export function retryRemoteRuntimeSharedControlConnectionNow(environmentId: string): void {
  sharedControlConnections.get(environmentId)?.connection.retryNow()
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
  // Why: a socket that still reads OPEN after wake arms no reconnect timer, so retryNow finds
  // nothing; probing every socket (shared control and per-stream) settles a dead path quickly (#9092).
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
    cached = {
      pairingKey,
      answeredAt: () => answeredAt,
      connection: new RemoteRuntimeSharedControlConnection(pairedConnection, {
        environmentId,
        clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
        ...sharedControlEnvironmentPolicy(environmentId),
        // Why wall clock: it advances across a suspend, so a pre-sleep answer reads as stale.
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
          statusOwners
            .get(environmentId)
            ?.owner.connectionChanged(
              diagnostics.state === 'ready'
                ? 'ready'
                : diagnostics.state === 'closed' || diagnostics.state === 'reconnecting'
                  ? 'disconnected'
                  : 'connecting',
              diagnostics
            )
        }
      })
    }
    sharedControlConnections.set(environmentId, cached)
    const entry = cached
    // Why ready is enough: a socket reaches ready only on its own server frame, which stamps it.
    setSharedControlAnswerSource(environmentId, () =>
      entry.connection.getDiagnostics().state === 'ready' ? entry.answeredAt() : null
    )
  }
  return cached.connection
}

function getPairingKey(pairedConnection: PairedRuntimeConnection): string {
  return [
    pairedConnection.endpoint,
    pairedConnection.credential.deviceToken,
    pairedConnection.hostPublicKeyB64
  ].join('\0')
}
