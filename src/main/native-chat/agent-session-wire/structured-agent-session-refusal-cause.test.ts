// A refusal's cause names the situation, so every place that answers for a refusal — the first
// reply, a ledger replay, the store fallback copy — must name the same one.

import { describe, expect, it } from 'vitest'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../shared/agent-session-record.test-fixture'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { classifyStoreFailure } from './structured-agent-session-attach'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal
} from './structured-agent-session-adapter'
import {
  failedAcquisitionRefusal,
  failedAcquisitionSettlement
} from './structured-agent-session-failed-create-refusal'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'

function replay(outcome: Parameters<typeof resolveAgentSessionReplayOutcome>[0]['outcome']) {
  return resolveAgentSessionReplayOutcome({
    operationId: 'op-1',
    outcome,
    reconstruct: () => null
  })
}

describe('a ledger replay names the cause its first answer did', () => {
  it.each([
    new AgentSessionAcquisitionRefusal(
      'not signed in',
      'agent_session_operation_invalid',
      'notSignedIn'
    ),
    new AgentSessionAcquisitionExitProvenError(new Error('spawn codex ENOENT'))
  ])('for a failed create: %s', (error) => {
    const first = failedAcquisitionRefusal(error)
    const replayed = replay(failedAcquisitionSettlement(error).outcome)
    expect(first?.refusal.cause).toBeDefined()
    expect(replayed).toMatchObject({
      decision: 'refuse',
      refusal: { code: first?.refusal.code, cause: first?.refusal.cause }
    })
  })

  it('for a create whose cleanup could not prove the child gone', () => {
    const outcome = failedAcquisitionSettlement(
      new AgentSessionAcquisitionExitUnprovenError(new Error('probe failed'))
    ).outcome
    expect(replay(outcome)).toMatchObject({
      refusal: { code: 'agent_session_ownership_unknown', cause: 'exitUnproven' }
    })
  })

  it('reads a row an older host wrote, with no cause, as naming none', () => {
    const replayed = replay({ status: 'failed', code: 'agent_session_conflict' })
    expect(replayed).toMatchObject({ refusal: { code: 'agent_session_conflict' } })
    expect(replayed.decision === 'refuse' && replayed.refusal).not.toHaveProperty('cause')
  })

  it('names a code this build cannot place as refused earlier', () => {
    expect(replay({ status: 'failed', code: 'agent_session_future_code' })).toMatchObject({
      refusal: { code: 'agent_session_operation_invalid', cause: 'operationRefusedEarlier' }
    })
  })

  it('names a lost outcome and a lost result', () => {
    expect(replay({ status: 'unknown' })).toMatchObject({ refusal: { cause: 'outcomeUnknown' } })
    expect(replay({ status: 'succeeded', sessionId: 's' })).toMatchObject({
      refusal: { cause: 'resultLost' }
    })
  })
})

describe('the store fallback copy', () => {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-1' }
    })
  )

  it('words a situation its code would misdescribe by the situation', () => {
    const refusal = classifyStoreFailure(
      agentSessionRefusalError('agent_session_ownership_unknown', 'replaySuperseded'),
      null,
      record
    )
    expect(refusal).toMatchObject({
      code: 'agent_session_ownership_unknown',
      cause: 'replaySuperseded'
    })
    // Not the latched-owner story: this owner is not in doubt, the replay is just stale.
    expect(refusal.message).not.toContain('4242')
  })

  it('keeps the latched-owner story, with its cause, for an owner it cannot prove gone', () => {
    const refusal = classifyStoreFailure(
      agentSessionRefusalError('agent_session_ownership_unknown', 'ownerUnproven'),
      null,
      record
    )
    expect(refusal.cause).toBe('ownerUnproven')
    expect(refusal.message).toContain('4242')
  })

  it('names the latch for a bare code an older path still throws', () => {
    expect(
      classifyStoreFailure(new Error('agent_session_conflict'), null, {
        ...record,
        lease: { ...record.lease, claimStatus: 'conflicted' }
      }).cause
    ).toBe('claimConflicted')
    expect(
      classifyStoreFailure(new Error('agent_session_conflict'), null, null)
    ).not.toHaveProperty('cause')
  })
})
