import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { StructuredAgentSessionLiveSubscribe } from '../../../src/shared/structured-agent-session-live-read'
import type { RpcClient } from '../transport/rpc-client'

function isSubscribeEvent(value: unknown): value is AgentSessionSubscribeEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  const type = value.type
  return type === 'snapshot' || type === 'batch' || type === 'reset' || type === 'end'
}

/**
 * Each stream opens once the hold settles, either way: a refused hold is an older host saying it
 * could not start the agent — which the next send does — never a reason to hide the transcript.
 */
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
