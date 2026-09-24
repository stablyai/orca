// The journal options one admitted sink append forwards.
//
// Its own module because four append paths need it and the sink's own file
// already depends on two of them. Every path calls this, so a row-level field
// added to the sink's options reaches the durable row through all four rather
// than through whichever spread the next change remembers to edit.

import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type { JournalItemAppendOptions } from '../agent-session-journal/journal-store-contracts'
import type { StructuredAgentSessionAppendOptions } from './structured-agent-session-event-sink'

export function structuredAgentSessionJournalAppendOptions(
  fence: number,
  options: StructuredAgentSessionAppendOptions
): JournalItemAppendOptions {
  return {
    fence,
    ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
    ...agentJournalLinkageFields(options)
  }
}
