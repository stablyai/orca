import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'

// An older host's refused hold must still allow transcript attachment.
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
