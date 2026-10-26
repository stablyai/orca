import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import type {
  ExpectedRuntimeSource,
  RuntimeOrchestrationEnvelope
} from '../../shared/runtime-rpc-envelope'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/agent-launch-runtime-capability'
import {
  sendRemoteRuntimeRequest,
  sendRemoteRuntimeRequestWithStatusPreflight
} from '../../shared/remote-runtime-client'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'
import { AGENT_REQUEST_CLI_CAPABILITIES } from '../agent-request-capabilities'

// Paired CLI callers are not exempt from the host's agent.launch gate like the local socket is.
const CLI_CLIENT_CAPABILITIES = [
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  ...AGENT_REQUEST_CLI_CAPABILITIES
] as const

/** Sends one paired RPC with CLI capabilities and an optional execution-host runtime pin. */
export async function sendWebSocketRequest<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  expectedRuntimeSource?: ExpectedRuntimeSource
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    return await sendRemoteRuntimeRequest<TResult>(
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      undefined,
      CLI_CLIENT_CAPABILITIES,
      expectedRuntimeSource
    )
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, error.data)
    }
    throw error
  }
}

/** Validates status on the paired socket before sending the RPC with its target-local pin. */
export async function sendWebSocketRequestWithStatusPreflight<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  validateStatus: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  envelope?: RuntimeOrchestrationEnvelope,
  expectedRuntimeSource?: ExpectedRuntimeSource
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    return await sendRemoteRuntimeRequestWithStatusPreflight<TResult>(
      connection,
      method,
      params,
      timeoutMs,
      validateStatus,
      envelope,
      CLI_CLIENT_CAPABILITIES,
      undefined,
      expectedRuntimeSource
    )
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, error.data)
    }
    throw error
  }
}
