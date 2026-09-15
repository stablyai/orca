import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { evictAgentSessionOwner } from './agent-session-lease-transitions'
import { applyAgentSessionRestartAdjudication } from './agent-session-restart-lease-transitions'

const NOW = 1_800_000_000_000

describe('proven-dead agent session eviction settlement', () => {
  it('latches restart eviction with a stable id while keeping the lease resumable', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({ runtimeKind: 'native', unreconciled: true })
    )

    const evicted = applyAgentSessionRestartAdjudication({
      record,
      probe: { outcome: 'pid-absent' },
      now: NOW
    })

    expect(evicted.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: 8,
      handoffStage: null,
      settlementRetryRequired: true,
      settlementRetryId: 'restart-eviction:session-alpha-1:8',
      deathEvidence: { kind: 'pid-absent', detail: 'recorded pid absent on host' }
    })
  })

  it('latches recovery eviction from the same evicted disposition', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({ runtimeKind: 'native', handoffStage: 'recovering' })
    )

    const evicted = evictAgentSessionOwner({
      record,
      expectedFence: 7,
      probe: { outcome: 'identity-mismatch', field: 'process-start-time' },
      now: NOW,
      journalSettlement: 'required'
    })

    expect(evicted.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: 8,
      handoffStage: null,
      settlementRetryRequired: true,
      settlementRetryId: 'restart-eviction:session-alpha-1:8',
      deathEvidence: { kind: 'identity-mismatch', detail: 'mismatched process-start-time' }
    })
  })

  it('never latches an indeterminate owner', () => {
    const restartRecord = agentSessionRecordFixture(
      agentSessionLeaseFixture({ runtimeKind: 'native', unreconciled: true })
    )
    const recovered = applyAgentSessionRestartAdjudication({
      record: restartRecord,
      probe: { outcome: 'indeterminate', reason: 'remote host unavailable' },
      now: NOW
    })
    const recoveryRecord = agentSessionRecordFixture(
      agentSessionLeaseFixture({ runtimeKind: 'native', handoffStage: 'recovering' })
    )

    expect(recovered.lease).toMatchObject({
      handoffStage: 'recovering',
      ownerProcess: { pid: 4242 }
    })
    expect(recovered.lease).not.toHaveProperty('settlementRetryRequired')
    expect(recovered.lease).not.toHaveProperty('settlementRetryId')
    expect(() =>
      evictAgentSessionOwner({
        record: recoveryRecord,
        expectedFence: 7,
        probe: { outcome: 'indeterminate', reason: 'remote host unavailable' },
        now: NOW,
        journalSettlement: 'required'
      })
    ).toThrow('agent_session_ownership_unknown')
    expect(recoveryRecord.lease).not.toHaveProperty('settlementRetryRequired')
    expect(recoveryRecord.lease).not.toHaveProperty('settlementRetryId')
  })

  it('preserves a null handoff stage when the latch survives another restart', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        runtimeKind: 'native',
        ownerProcess: null,
        reservedSpawnToken: null,
        claimStatus: 'released',
        handoffStage: null,
        settlementRetryRequired: true,
        settlementRetryId: 'restart-eviction:session-alpha-1:8',
        unreconciled: true
      })
    )

    const restored = applyAgentSessionRestartAdjudication({
      record,
      probe: { outcome: 'indeterminate', reason: 'remote host unavailable' },
      now: NOW
    })

    expect(restored.lease).toMatchObject({
      handoffStage: null,
      settlementRetryRequired: true,
      settlementRetryId: 'restart-eviction:session-alpha-1:8',
      unreconciled: false
    })
  })

  it('evicts a TUI owner even when an earlier generation still needs settlement', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        runtimeKind: 'tui',
        settlementRetryRequired: true,
        settlementRetryId: 'old-generation',
        settlementRetryFence: 4,
        deathEvidence: {
          kind: 'exit-observed',
          detail: 'old generation exited',
          observedAt: NOW - 1
        }
      })
    )

    const evicted = evictAgentSessionOwner({
      record,
      expectedFence: 7,
      probe: { outcome: 'pid-absent' },
      now: NOW,
      journalSettlement: 'required'
    })

    expect(evicted.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: 8,
      settlementRetryRequired: true,
      settlementRetryId: 'restart-eviction:session-alpha-1:8',
      settlementRetryFence: 7,
      deathEvidence: { kind: 'pid-absent' }
    })
  })

  it('keeps an earlier settlement latch across an intentional eviction', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        runtimeKind: 'tui',
        settlementRetryRequired: true,
        settlementRetryId: 'old-generation',
        settlementRetryFence: 4,
        deathEvidence: {
          kind: 'exit-observed',
          detail: 'old generation exited',
          observedAt: NOW - 1
        }
      })
    )

    const evicted = evictAgentSessionOwner({
      record,
      expectedFence: 7,
      probe: { outcome: 'exit-observed' },
      now: NOW,
      journalSettlement: 'not-required'
    })

    expect(evicted.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: 8,
      settlementRetryRequired: true,
      settlementRetryId: 'old-generation',
      settlementRetryFence: 4,
      deathEvidence: { detail: 'old generation exited' }
    })
  })
})
