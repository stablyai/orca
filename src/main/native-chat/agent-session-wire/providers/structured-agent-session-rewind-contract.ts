import type {
  AgentSessionRewindRecord,
  AgentSessionRewindReason
} from '../../../../shared/agent-session/lifecycle/agent-session-rewind'

export type PrepareStructuredRewind = (input: {
  sessionId: string
  fence: number
  beforeTurnId: string
}) => Promise<
  | { ok: true; revert: NonNullable<AgentSessionRewindRecord['providerRevert']> }
  | { ok: false; reason: AgentSessionRewindReason }
>
