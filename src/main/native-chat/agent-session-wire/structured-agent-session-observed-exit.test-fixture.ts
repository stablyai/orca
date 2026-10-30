import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { StructuredAgentSessionDeadGenerationInput } from './structured-agent-session-dead-generation-settlement'
import { settleStructuredAgentSessionLeftovers } from './structured-agent-session-leftover-settlement'

/** ownerFence defaults to all fences for a single-generation chat. */
export function settleObservedExitForTest(
  input: StructuredAgentSessionDeadGenerationInput & {
    journal: AgentSessionJournal
    ownerFence?: number
  }
) {
  const { journal, sessionId, fence, ownerFence = 0, ...exit } = input
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId,
      runtimeFence: fence,
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null
    })
  )
  return settleStructuredAgentSessionLeftovers({
    store: { getRecord: () => record },
    sessionId,
    journal,
    exit: { ...exit, ownerFence }
  })
}
