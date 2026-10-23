import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { sendRemoteRuntimeRequest } from '../../../shared/remote-runtime-client'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'
import {
  sendRemoteRuntimeConnectionRequest,
  sendRemoteRuntimeSharedControlRequest
} from './runtime-environment-request-connections'

export function sendRemoteRuntimeRequestAbortable(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  signal?: AbortSignal,
  clientCapabilities: readonly RuntimeCapability[] = [],
  beforeSend?: () => void
): Promise<RuntimeRpcResponse<unknown>> {
  if (signal || clientCapabilities.length > 0 || beforeSend) {
    return sendRemoteRuntimeRequest(
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      signal,
      clientCapabilities,
      beforeSend
    )
  }
  return envelope
    ? sendRemoteRuntimeRequest(connection, method, params, timeoutMs, envelope)
    : sendRemoteRuntimeRequest(connection, method, params, timeoutMs)
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
  beforeSend?: () => void
): Promise<RuntimeRpcResponse<unknown>> {
  if (signal || beforeSend) {
    return sendRemoteRuntimeSharedControlRequest(
      environmentId,
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      signal,
      beforeSend
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
