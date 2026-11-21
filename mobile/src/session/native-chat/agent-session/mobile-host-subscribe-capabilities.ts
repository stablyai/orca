import {
  type AgentSessionTextAppendCapabilities,
  agentSessionTextAppendRequest
} from '../../../../../src/shared/agent-session/view/live-read/agent-session-text-append'
import {
  readRuntimeStatusProbe,
  recordRuntimeStatusProbe
} from '../../../transport/connection/runtime-status-probe'
import { decodeHostStatusReply, readHostStatusReply } from '../../../query/host-status-query'
import { hostStatusSchema } from '../../../transport/hosts/host-status-reply-schema'
import {
  AGENT_SESSION_LIVE_TEXT_VIEWER_RUNTIME_CAPABILITY,
  AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY
} from '../../../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'

// Read alongside the hold, so the stream's first open knows what to ask for: this connection's
// probe, else the status the shell proved (direct hosts only), else the connection's status read.
export async function hostCapabilities(client: RpcClient): Promise<readonly string[]> {
  let status = readRuntimeStatusProbe(client)
  const shell =
    status === undefined ? hostStatusSchema.safeParse(client.getShellHostStatus?.()) : null
  if (shell?.success) {
    status = shell.data
  } else if (status === undefined) {
    const reply = await readHostStatusReply(client, {
      timeoutMs: 15_000,
      failWhenDisconnected: true
    }).catch(() => null)
    const landed = reply ? decodeHostStatusReply(reply) : null
    if (landed) {
      recordRuntimeStatusProbe(client, landed.status)
    }
    status = landed?.status
  }
  return status?.capabilities ?? []
}

export function hostTextAppends(
  advertised: readonly string[]
): AgentSessionTextAppendCapabilities | null {
  return agentSessionTextAppendRequest({
    textAppend: advertised.includes(AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY),
    toolOutputAppend: advertised.includes(AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY)
  })
}

export const hostLiveTextViewer = (advertised: readonly string[]): boolean =>
  advertised.includes(AGENT_SESSION_LIVE_TEXT_VIEWER_RUNTIME_CAPABILITY)
