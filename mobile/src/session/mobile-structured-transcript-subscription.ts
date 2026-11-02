import type { RpcClient } from '../transport/rpc-client'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'

/**
 * Opens the transcript stream once the hold settles, either way: a refused hold is an older host
 * saying it could not start the agent — which the next send does — never a reason to hide the
 * transcript. Returns what ends the stream, opened or not yet. Outside the effect so its cleanup
 * rule can see the stream is owned.
 */
export function openTranscriptAfterHold(
  client: RpcClient,
  sessionId: string,
  held: Promise<unknown>,
  onFrame: (raw: unknown) => void
): () => void {
  let ended = false
  let close = (): void => {}
  void held
    .catch(() => undefined)
    .then(() => {
      if (!ended) {
        close = client.subscribe('agentSession.subscribe', { sessionId }, onFrame)
      }
    })
  return () => {
    ended = true
    close()
  }
}

export function isSubscribeEvent(value: unknown): value is AgentSessionSubscribeEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const type = 'type' in value ? value.type : undefined
  return type === 'snapshot' || type === 'batch' || type === 'reset' || type === 'end'
}
