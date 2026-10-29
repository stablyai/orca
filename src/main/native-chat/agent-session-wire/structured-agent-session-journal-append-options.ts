import { journalItemEchoFields } from '../agent-session-journal/journal-item-echo'
// Centralize admitted single-item options; lifecycle batches carry producers per mutation.
// Child-bound sink fences identify the execution that produced each row.

import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type { JournalItemAppendOptions } from '../agent-session-journal/journal-store-contracts'
import type { StructuredAgentSessionItemAppendOptions } from './structured-agent-session-event-sink'

export function structuredAgentSessionJournalAppendOptions(
  fence: number,
  options: StructuredAgentSessionItemAppendOptions
): JournalItemAppendOptions {
  return {
    fence,
    ...journalItemEchoFields(options),
    ownerFence: fence,
    ...(options.executes ? { executionOwner: fence } : {}),
    ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
    turnScope: options.turnScope,
    ...agentJournalLinkageFields(options)
  }
}
