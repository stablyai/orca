import {
  agentSessionFailureFact,
  type AgentSessionFailureFact,
  type ProviderDiagnostic
} from '../../../shared/agent-session-failure'

export type StructuredConversationCommandOutcome = {
  outcome: 'success' | 'failure' | 'cancellation'
  failure?: AgentSessionFailureFact
}

export type StructuredCompactionEvidence = {
  /** Claude boundary or Codex compaction item. */
  compacted: boolean
  interruptRequested: boolean
  failed?: { detail?: ProviderDiagnostic } | null
}

/** Claude reports stopped /compact as success; require compaction evidence before accepting that verdict.
 * Otherwise classify requested Stop as cancellation, or report provider/unconfirmed failure. */
export function structuredCompactionOutcome(
  evidence: StructuredCompactionEvidence
): StructuredConversationCommandOutcome {
  if (evidence.compacted) {
    return { outcome: 'success' }
  }
  if (evidence.interruptRequested) {
    return { outcome: 'cancellation' }
  }
  return {
    outcome: 'failure',
    failure: evidence.failed
      ? agentSessionFailureFact('compactionFailed', { detail: evidence.failed.detail })
      : agentSessionFailureFact('compactionUnconfirmed')
  }
}
