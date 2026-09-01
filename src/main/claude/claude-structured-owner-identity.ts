import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'

export function claudeProviderHandleLink(input: {
  sessionId: string
  leafUuid: string | null
  resumed: boolean
  origin?: 'adopted'
  fence: number
  linkId?: string
  observedAt: number
}): AgentSessionProviderHandleLink {
  return {
    linkId:
      input.linkId ??
      `claude-${input.fence}-${input.sessionId}-${input.leafUuid ?? 'empty'}`.slice(0, 128),
    handle: { provider: 'claude', sessionId: input.sessionId, leafUuid: input.leafUuid },
    origin: input.origin ?? (input.resumed ? 'resumed' : 'created'),
    mintedAtFence: input.fence,
    observedAt: input.observedAt
  }
}
