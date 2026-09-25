import type { PairingOffer } from '../../shared/pairing'
import type { RuntimeCapability } from '../../shared/protocol-version'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../shared/runtime-rpc-envelope'
import {
  sendRemoteRuntimeConnectionRequest,
  sendRemoteRuntimeSharedControlRequest
} from './runtime-environment-request-connections'

export function sendRemoteRuntimeRequestAbortable(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal,
  clientCapabilities: readonly RuntimeCapability[] = []
): Promise<RuntimeRpcResponse<unknown>> {
  if (signal || clientCapabilities.length > 0) {
    return sendRemoteRuntimeRequest(
      pairing,
      method,
      params,
      timeoutMs,
      envelope,
      signal,
      clientCapabilities
    )
  }
  return envelope
    ? sendRemoteRuntimeRequest(pairing, method, params, timeoutMs, envelope)
    : sendRemoteRuntimeRequest(pairing, method, params, timeoutMs)
}

export function sendRemoteRuntimeConnectionRequestAbortable(
  environmentId: string,
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<unknown>> {
  return signal
    ? sendRemoteRuntimeConnectionRequest(environmentId, pairing, method, params, timeoutMs, signal)
    : sendRemoteRuntimeConnectionRequest(environmentId, pairing, method, params, timeoutMs)
}

export function sendRemoteRuntimeSharedControlRequestAbortable(
  environmentId: string,
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<unknown>> {
  if (signal) {
    return sendRemoteRuntimeSharedControlRequest(
      environmentId,
      pairing,
      method,
      params,
      timeoutMs,
      envelope,
      signal
    )
  }
  return envelope
    ? sendRemoteRuntimeSharedControlRequest(
        environmentId,
        pairing,
        method,
        params,
        timeoutMs,
        envelope
      )
    : sendRemoteRuntimeSharedControlRequest(environmentId, pairing, method, params, timeoutMs)
}
