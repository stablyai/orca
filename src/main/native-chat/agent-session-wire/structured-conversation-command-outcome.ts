// How a conversation command the provider ran ended, read the same way for every provider.

import {
  agentSessionFailureFact,
  type AgentSessionFailureFact,
  type ProviderDiagnostic
} from '../../../shared/agent-session-failure'

export type StructuredConversationCommandOutcome = {
  outcome: 'success' | 'failure' | 'cancellation'
  /** On a failure: what its row reports. */
  failure?: AgentSessionFailureFact
}

/** What the provider showed of one compaction while it ran. */
export type StructuredCompactionEvidence = {
  /** The provider reported the conversation compacted: Claude's boundary, Codex's item. */
  compacted: boolean
  /** Orca asked the provider to stop the command. */
  interruptRequested: boolean
  /** The provider said the compaction failed, with its words for a person when it gave any. */
  failed?: { detail?: ProviderDiagnostic } | null
}

/** Only a compaction the provider reported doing is a success: Claude answers a stopped `/compact`
 *  with the same success result as a finished one, so the result's own verdict cannot decide. With
 *  none, one Orca asked to stop is the user's cancellation; anything else failed — reported as the
 *  provider's failure when it said so, and otherwise as a compaction it never confirmed. */
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
