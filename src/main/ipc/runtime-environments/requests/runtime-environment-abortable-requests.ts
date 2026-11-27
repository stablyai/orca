import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type { RuntimeCapability } from '../../../../shared/remote-runtime/protocol/protocol-version'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import type {
  RuntimeRequestGuard,
  RuntimeRequestPreparation,
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
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
  prepareGuard?: RuntimeRequestGuard,
  responseTimeoutMs?: number
): Promise<RuntimeRpcResponse<unknown>> {
  if (
    signal ||
    clientCapabilities.length > 0 ||
    prepareRequest ||
    prepareGuard ||
    responseTimeoutMs !== undefined
  ) {
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
      prepareGuard,
      responseTimeoutMs
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
  prepareGuard?: RuntimeRequestGuard,
  responseTimeoutMs?: number,
  idlePassive?: boolean
): Promise<RuntimeRpcResponse<unknown>> {
  if (signal || prepareRequest || prepareGuard || responseTimeoutMs !== undefined || idlePassive) {
    return sendRemoteRuntimeSharedControlRequest(
      environmentId,
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      signal,
      prepareRequest,
      prepareGuard,
      responseTimeoutMs,
      idlePassive
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
