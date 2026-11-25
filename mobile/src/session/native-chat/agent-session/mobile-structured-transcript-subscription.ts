import type { AgentSessionSubscribeEvent } from '../../../../../src/shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionLiveSubscribe } from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-live-read'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import {
  type AgentSessionTextAppendCapabilities,
  agentSessionTextAppendRequest
} from '../../../../../src/shared/agent-session/view/live-read/agent-session-text-append'
import {
  AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY
} from '../../../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import {
  readRuntimeStatusProbe,
  recordRuntimeStatusProbe
} from '../../../transport/connection/runtime-status-probe'
import { decodeHostStatusReply, readHostStatusReply } from '../../../query/host-status-query'
import { hostStatusSchema } from '../../../transport/hosts/host-status-reply-schema'

// Read alongside the hold so the first subscription can request text appends.
export async function hostTextAppends(
  client: RpcClient
): Promise<AgentSessionTextAppendCapabilities | null> {
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
  const advertised = status?.capabilities ?? []
  return agentSessionTextAppendRequest({
    textAppend: advertised.includes(AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY),
    toolOutputAppend: advertised.includes(AGENT_SESSION_TOOL_OUTPUT_APPEND_RUNTIME_CAPABILITY)
  })
}

function isSubscribeEvent(value: unknown): value is AgentSessionSubscribeEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  const type = value.type
  return type === 'snapshot' || type === 'batch' || type === 'reset' || type === 'end'
}

// Subscribe after the hold settles even on refusal: older hosts can start on the next send, so their transcript must remain visible.
export function subscribeTranscriptAfterHold(
  client: RpcClient,
  held: Promise<unknown>,
  isEnded: () => boolean
): StructuredAgentSessionLiveSubscribe {
  return async (params, onEvent, onError) => {
    await held.catch(() => undefined)
    if (isEnded()) {
      return { unsubscribe: () => {} }
    }
    const close = client.subscribe('agentSession.subscribe', params, (raw) => {
      if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'error') {
        // A stream's error frame carries the host's error, refusal and all, under `error`.
        onError('error' in raw && raw.error !== undefined ? raw.error : raw)
        return
      }
      if (isSubscribeEvent(raw)) {
        onEvent(raw)
      }
    })
    return { unsubscribe: close }
  }
}
