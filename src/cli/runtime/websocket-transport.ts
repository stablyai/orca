import type { PairedRuntimeConnection } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import type {
  RuntimeRequestSelection,
  RuntimeOrchestrationEnvelope
} from '../../shared/runtime-rpc-envelope'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { AGENT_SESSION_RENAME_ONLY_CLIENT_CAPABILITY } from '../../shared/agent-session/structured-agent-session-surface-capabilities'
import { REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'
import { CLI_AGENT_CALLER_CLIENT_CAPABILITY } from '../../shared/remote-runtime/cli-agent-caller-capability'
import { sendRemoteRuntimeRequestOnSocket } from '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'

// Paired CLI callers are not exempt from the host's agent.launch or chat rename gates like the local socket is.
const CLI_CLIENT_CAPABILITIES = [
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  AGENT_SESSION_RENAME_ONLY_CLIENT_CAPABILITY,
  CLI_AGENT_CALLER_CLIENT_CAPABILITY
] as const

export async function sendWebSocketRequest<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    return await sendRemoteRuntimeRequestOnSocket<TResult>(
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      undefined,
      undefined,
      CLI_CLIENT_CAPABILITIES,
      undefined,
      undefined
    )
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, error.data)
    }
    throw error
  }
}

export async function sendWebSocketRequestWithStatusPreflight<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  validateStatus: (response: RuntimeRpcResponse<RuntimeStatus>) => void,
  envelope?: RuntimeOrchestrationEnvelope,
  requestSelection?: RuntimeRequestSelection
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    return await sendRemoteRuntimeRequestOnSocket<TResult>(
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      validateStatus,
      undefined,
      CLI_CLIENT_CAPABILITIES,
      requestSelection,
      undefined
    )
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, error.data)
    }
    throw error
  }
}
