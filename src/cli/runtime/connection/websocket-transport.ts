import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type {
  RuntimeRequestSelection,
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import {
  AGENT_SESSION_RENAME_ONLY_CLIENT_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from '../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import {
  REPO_SEARCH_CANONICAL_REFS_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY
} from '../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { CLI_AGENT_CALLER_CLIENT_CAPABILITY } from '../../../shared/remote-runtime/cli-agent-caller-capability'
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../../shared/bot-runtime-capabilities'
import { sendRemoteRuntimeRequestOnSocket } from '../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import type { RuntimeStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { RuntimeClientError } from './types'
import {
  RUNTIME_RPC_READ_STAGED_REPLY_METHOD,
  RUNTIME_RPC_STAGED_REPLY_CLIENT_CAPABILITY,
  type RuntimeRpcStagedReplyPart
} from '../../../shared/remote-runtime/rpc/runtime-rpc-staged-reply'
import { readRuntimeRpcStagedReply } from '../../../shared/remote-runtime/requests/runtime-rpc-staged-reply-read'

// Paired CLI callers are not exempt from the host's agent.launch or chat rename gates like the local socket is.
export const CLI_CLIENT_CAPABILITIES = [
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  REPO_SEARCH_CANONICAL_REFS_RUNTIME_CAPABILITY,
  AGENT_SESSION_RENAME_ONLY_CLIENT_CAPABILITY,
  CLI_AGENT_CALLER_CLIENT_CAPABILITY,
  // Without it a paired host prints Waiting items as in_progress.
  BOTS_ITEM_WAITING_CAPABILITY,
  // A full-page screenshot can outgrow one reply.
  RUNTIME_RPC_STAGED_REPLY_CLIENT_CAPABILITY
] as const

// `agent read` prints chats as text the host projects, so it reads every chat agent; only that
// request says so, leaving how other commands launch and list chats unchanged.
const AGENT_READ_CLIENT_CAPABILITIES = [
  ...CLI_CLIENT_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY
] as const

function clientCapabilitiesFor(method: string) {
  return method === 'agent.read' ? AGENT_READ_CLIENT_CAPABILITIES : CLI_CLIENT_CAPABILITIES
}

export async function sendWebSocketRequest<TResult>(
  connection: PairedRuntimeConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    const response = await sendRemoteRuntimeRequestOnSocket<TResult>(
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      undefined,
      undefined,
      clientCapabilitiesFor(method),
      undefined,
      undefined
    )
    return await readStagedReply(connection, response, timeoutMs)
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
    const response = await sendRemoteRuntimeRequestOnSocket<TResult>(
      connection,
      method,
      params,
      timeoutMs,
      envelope,
      validateStatus,
      undefined,
      clientCapabilitiesFor(method),
      requestSelection,
      undefined
    )
    return await readStagedReply(connection, response, timeoutMs)
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, error.data)
    }
    throw error
  }
}

// A host that staged a reply too large for one frame hands it back in parts, one request each.
async function readStagedReply<TResult>(
  connection: PairedRuntimeConnection,
  response: RuntimeRpcResponse<TResult>,
  timeoutMs: number
): Promise<RuntimeRpcResponse<TResult>> {
  return await readRuntimeRpcStagedReply(response, (params) =>
    sendRemoteRuntimeRequestOnSocket<RuntimeRpcStagedReplyPart>(
      connection,
      RUNTIME_RPC_READ_STAGED_REPLY_METHOD,
      params,
      timeoutMs,
      undefined,
      undefined,
      undefined,
      CLI_CLIENT_CAPABILITIES
    )
  )
}
