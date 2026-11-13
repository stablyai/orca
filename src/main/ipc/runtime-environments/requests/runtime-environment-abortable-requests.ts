import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import type {
  RuntimeRequestGuard,
  RuntimeRequestPreparation,
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../../shared/runtime-rpc-envelope'
import {
  sendRemoteRuntimeConnectionRequest,
  sendRemoteRuntimeSharedControlRequest
} from '../connections/runtime-environment-request-connections'

export function sendRemoteRuntimeRequestAbortable(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal,
  clientCapabilities: readonly RuntimeCapability[] = [],
  prepareRequest?: RuntimeRequestPreparation,
  prepareGuard?: RuntimeRequestGuard
): Promise<RuntimeRpcResponse<unknown>> {
  if (signal || clientCapabilities.length > 0 || prepareRequest || prepareGuard) {
    return sendRemoteRuntimeRequestOnSocket(
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      undefined,
      signal,
      clientCapabilities,
      undefined,
      prepareRequest,
      undefined,
      prepareGuard
    )
  }
  return envelope
    ? sendRemoteRuntimeRequestOnSocket(
        connection,
        method,
        params,
        timeoutMs,
        envelope,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
    : sendRemoteRuntimeRequestOnSocket(
        connection,
        method,
        params,
        timeoutMs,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
}

export function sendRemoteRuntimeConnectionRequestAbortable(
  environmentId: string,
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<unknown>> {
  return signal
    ? sendRemoteRuntimeConnectionRequest(
        environmentId,
        connection,
        method,
        params,
        timeoutMs,
        signal
      )
    : sendRemoteRuntimeConnectionRequest(environmentId, connection, method, params, timeoutMs)
}

export function sendRemoteRuntimeSharedControlRequestAbortable(
  environmentId: string,
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal,
  prepareRequest?: RuntimeRequestPreparation,
  prepareGuard?: RuntimeRequestGuard
): Promise<RuntimeRpcResponse<unknown>> {
  if (signal || prepareRequest || prepareGuard) {
    return sendRemoteRuntimeSharedControlRequest(
      environmentId,
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      signal,
      prepareRequest,
      prepareGuard
    )
  }
  return envelope
    ? sendRemoteRuntimeSharedControlRequest(
        environmentId,
        connection,
        method,
        params,
        timeoutMs,
        envelope
      )
    : sendRemoteRuntimeSharedControlRequest(environmentId, connection, method, params, timeoutMs)
}
