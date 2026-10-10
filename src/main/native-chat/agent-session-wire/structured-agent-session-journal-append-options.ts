// The journal options one admitted single-item sink append forwards.
//
// Every such path calls this, so a row-level field added to the sink's options
// reaches the durable row through one edit rather than through whichever spread
// the next change remembers. Lifecycle batches carry producers per mutation.
//
// The sink carries only the provider's own observations, bound at its child's fence: that fence is
// the generation whose execution produced each item (`JournalItemRow.ownerFence`).

import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type { JournalItemAppendOptions } from '../agent-session-journal/journal-store-contracts'
import type { StructuredAgentSessionItemAppendOptions } from './structured-agent-session-event-sink'

export function structuredAgentSessionJournalAppendOptions(
  fence: number,
  options: StructuredAgentSessionItemAppendOptions
): JournalItemAppendOptions {
  return {
    fence,
    ownerFence: fence,
    ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
    turnScope: options.turnScope,
    ...agentJournalLinkageFields(options)
  }
}
