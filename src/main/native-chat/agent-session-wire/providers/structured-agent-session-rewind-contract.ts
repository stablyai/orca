import type { AgentSessionRewindRecord } from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import type { AgentSessionRewindReason } from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind-reasons'

export type PrepareStructuredRewind = (input: {
  sessionId: string
  fence: number
  beforeTurnId: string
}) => Promise<
  | { ok: true; revert: NonNullable<AgentSessionRewindRecord['providerRevert']> }
  | { ok: false; reason: AgentSessionRewindReason }
>
