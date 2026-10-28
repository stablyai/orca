import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { RemoteRuntimeSharedControlConnection } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcFailure,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'

export type SharedControlSocketStatus = {
  socketGeneration: number
  status: RuntimeRpcResponse<RuntimeStatus>
}

/** Which shared sockets may carry a call, judged from that socket's own `status.get`. */
export type SharedControlAdmission = {
  admits: (status: RuntimeStatus) => boolean
  /** Reuses a socket's ok status until that socket is replaced; one probe in flight per connection. */
  cache?: WeakMap<RemoteRuntimeSharedControlConnection, Promise<SharedControlSocketStatus>>
}

export type SharedControlAdmittedSend<TResult> =
  | { kind: 'sent'; response: RuntimeRpcResponse<TResult> }
  /** The socket's own `status.get` failed; nothing was sent. */
  | { kind: 'status_failed'; response: RuntimeRpcFailure }
  | { kind: 'refused' }
  /** The socket was replaced between its status and the send; nothing was sent. */
  | { kind: 'socket_changed' }

export type SharedControlAdmittedCall = {
  method: string
  params: unknown
  /** Read before each request, so a caller can spend one deadline across the probe and the send. */
  remainingMs: () => number
  envelope?: RuntimeOrchestrationEnvelope
  signal?: AbortSignal
}

/** Sends only on a shared socket whose own status `admission` accepted, and only while that socket is current. */
export async function sendSharedControlRequestWhenAdmitted<TResult>(
  shared: RemoteRuntimeSharedControlConnection,
  call: SharedControlAdmittedCall,
  admission: SharedControlAdmission
): Promise<SharedControlAdmittedSend<TResult>> {
  const { socketGeneration, status } = await statusOnSocket(
    shared,
    call.remainingMs(),
    call.signal,
    admission.cache
  )
  if (!status.ok) {
    return { kind: 'status_failed', response: status }
  }
  if (!admission.admits(status.result)) {
    return { kind: 'refused' }
  }
  let socketChanged = false
  try {
    const response = await shared.request<TResult>(
      call.method,
      call.params,
      call.remainingMs(),
      call.envelope,
      call.signal,
      () => {
        socketChanged = !shared.socketGeneration.isCurrent(socketGeneration)
        if (socketChanged) {
          throw new Error('Runtime connection changed before sending')
        }
      }
    )
    return { kind: 'sent', response }
  } catch (error) {
    if (socketChanged) {
      return { kind: 'socket_changed' }
    }
    throw error
  }
}

async function statusOnSocket(
  shared: RemoteRuntimeSharedControlConnection,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  cache: SharedControlAdmission['cache']
): Promise<SharedControlSocketStatus> {
  if (!cache) {
    return probeSocketStatus(shared, timeoutMs, signal)
  }
  const cached = cache.get(shared)
  if (cached) {
    const known = await waitForPromiseWithSignal(cached, signal)
    if (shared.socketGeneration.isCurrent(known.socketGeneration)) {
      return known
    }
  }
  const current = cache.get(shared)
  // A concurrent caller already started the re-probe this one would.
  if (current && current !== cached) {
    return waitForPromiseWithSignal(current, signal)
  }
  // No signal: every waiting caller shares this probe, so one caller's abort must not fail the rest.
  const probe = probeSocketStatus(shared, timeoutMs, undefined)
  cache.set(shared, probe)
  const evict = (): void => {
    if (cache.get(shared) === probe) {
      cache.delete(shared)
    }
  }
  // A failed status (e.g. runtime_busy) says nothing about the socket; the next call asks again.
  probe.then((known) => {
    if (!known.status.ok) {
      evict()
    }
  }, evict)
  return waitForPromiseWithSignal(probe, signal)
}

async function probeSocketStatus(
  shared: RemoteRuntimeSharedControlConnection,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<SharedControlSocketStatus> {
  let socketGeneration = -1
  const status = await shared.request<RuntimeStatus>(
    'status.get',
    undefined,
    timeoutMs,
    undefined,
    signal,
    () => {
      socketGeneration = shared.socketGeneration.peek()
    }
  )
  return { socketGeneration, status }
}
