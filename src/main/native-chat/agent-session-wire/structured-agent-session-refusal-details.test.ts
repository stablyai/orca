import { describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'
void {
  record: agentSessionRecordFixture(),
  newSession: true
}

function replay(outcome: Parameters<typeof resolveAgentSessionReplayOutcome>[0]['outcome']) {
  return resolveAgentSessionReplayOutcome({
    operationId: 'op-1',
    outcome,
    reconstruct: () => null
  })
}

describe('a ledger replay names the details its first answer did', () => {
  it('names a code this build cannot place as refused earlier', () => {
    expect(replay({ status: 'failed', code: 'agent_session_future_code' })).toMatchObject({
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'operationRefusedEarlier' }
      }
    })
  })
})
