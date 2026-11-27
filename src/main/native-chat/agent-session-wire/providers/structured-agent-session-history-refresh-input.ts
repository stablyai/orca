import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionEventSink } from '../journal-ingress/structured-agent-session-event-sink'

export type AgentHistoryReader = {
  /** Read external history without resuming the provider conversation or acquiring its writer. */
  refreshHistory?(input: StructuredAgentSessionHistoryRefreshInput): Promise<void>
}

export type StructuredAgentSessionHistoryRefreshInput = {
  record: AgentSessionRecord
  providerSessionId: string
  sink: StructuredAgentSessionEventSink
  assertCurrent: () => void
  signal: AbortSignal
  onSkipped: (reason: string) => void
}
