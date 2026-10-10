// An observed exit's settlement as the host's retry writes it (`settleStructuredAgentSessionLeftovers`
// with the exit's own account), for a chat whose lease that exit released.

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { backgroundSettlementWrites } from './structured-agent-session-background-writes'
import type { StructuredAgentSessionDeadGenerationInput } from './structured-agent-session-dead-generation-settlement'
import { settleStructuredAgentSessionLeftovers } from './structured-agent-session-leftover-settlement'
import { scanRecord } from './structured-agent-session-startup-scan.test-fixture'

/** `ownerFence`: the exited generation's; by default every fence, as a chat's lone generation. */
export function settleObservedExitForTest(
  input: StructuredAgentSessionDeadGenerationInput & {
    journal: AgentSessionJournal
    ownerFence?: number
  }
) {
  const { journal, sessionId, fence, ownerFence = 0, ...exit } = input
  const released = scanRecord(sessionId, true)
  const record = { ...released, lease: { ...released.lease, runtimeFence: fence } }
  return settleStructuredAgentSessionLeftovers({
    store: { getRecord: () => record },
    sessionId,
    journal,
    writes: backgroundSettlementWrites(journal),
    exit: { ...exit, ownerFence }
  })
}
