import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { recoverDeadTuiOwnerForHandoff } from './agent-session-handoff-lease-transitions'
import { applyAgentSessionRestartAdjudication } from './agent-session-restart-lease-transitions'

describe('agent session handoff restart transitions', () => {
  it('turns a proven dead TUI owner into one durable retry owner', () => {
    const operationId = '1800000000000-00000000000000000000000000000001'
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({ runtimeKind: 'tui', runtimeFence: 3 })
    )

    const next = recoverDeadTuiOwnerForHandoff({
      record,
      expectedFence: 3,
      operationId,
      probe: { outcome: 'pid-absent' },
      now: 1_800_000_001_000
    })

    expect(next.lease).toMatchObject({
      runtimeKind: 'tui',
      runtimeFence: 4,
      handoffStage: 'old-owner-stopped',
      handoffOperationId: operationId,
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'pid-absent' }
    })
  })

  it('preserves the stopped owner and operation for durable retry', () => {
    const handoffOperationId = '1800000000000-00000000000000000000000000000001'
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        runtimeKind: 'native',
        runtimeFence: 4,
        handoffStage: 'old-owner-stopped',
        handoffOperationId,
        claimStatus: 'released',
        ownerProcess: null,
        reservedSpawnToken: null,
        unreconciled: true
      })
    )

    const next = applyAgentSessionRestartAdjudication({
      record,
      probe: { outcome: 'reservation-unused' },
      now: 1_800_000_001_000
    })

    expect(next.lease).toMatchObject({
      runtimeKind: 'native',
      runtimeFence: 4,
      handoffStage: 'old-owner-stopped',
      handoffOperationId,
      claimStatus: 'released',
      ownerProcess: null,
      unreconciled: false
    })
  })
})
