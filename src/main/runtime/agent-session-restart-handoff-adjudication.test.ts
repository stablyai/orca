import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import { adjudicateRestartedAgentSessionHandoff } from './agent-session-restart-handoff-adjudication'

const NOW = 1_800_000_000_000

function record(stage: 'preparing' | 'new-owner-proving'): AgentSessionRecord {
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: 'session-restart',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    providerHandleChain: [],
    accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex' },
    lease: {
      sessionId: 'session-restart',
      runtimeKind: stage === 'preparing' ? 'native' : 'tui',
      runtimeFence: 4,
      handoffStage: stage,
      provenHandleLinkId: null,
      ownerProcess: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: NOW - 1_000,
        spawnToken: 'spawn-restart'
      },
      reservedSpawnToken: 'spawn-restart',
      leaseDeadlineAt: NOW + 30_000,
      lastRenewedAt: NOW,
      handoffOperationId: 'handoff-op-1',
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: stage === 'preparing' ? 'live' : 'reserved',
      unreconciled: true,
      deathEvidence: null
    },
    createdAt: NOW,
    updatedAt: NOW
  }
}

describe('restarted handoff adjudication', () => {
  it('continues a dead preparing owner at old-owner-stopped under the same operation', () => {
    expect(
      adjudicateRestartedAgentSessionHandoff(
        record('preparing'),
        { outcome: 'pid-absent' },
        NOW + 1_000
      ).lease
    ).toMatchObject({
      runtimeKind: 'native',
      runtimeFence: 5,
      handoffStage: 'old-owner-stopped',
      handoffOperationId: 'handoff-op-1',
      claimStatus: 'released',
      ownerProcess: null
    })
  })

  it('routes an ownerless indeterminate reservation to manual recovery at the same fence', () => {
    const abandoned = record('new-owner-proving')
    abandoned.lease.runtimeKind = 'native'
    abandoned.lease.ownerProcess = null
    expect(
      adjudicateRestartedAgentSessionHandoff(
        abandoned,
        { outcome: 'indeterminate', reason: 'no spawn-token scan' },
        NOW + 1_000
      ).lease
    ).toMatchObject({
      runtimeKind: 'native',
      runtimeFence: 4,
      handoffStage: 'manual-recovery',
      handoffOperationId: 'handoff-op-1',
      claimStatus: 'reserved',
      ownerProcess: null,
      reservedSpawnToken: 'spawn-restart'
    })
  })

  it('releases a proving reservation only with durable processless proof', () => {
    const processless = record('new-owner-proving')
    processless.lease.runtimeKind = 'native'
    processless.lease.ownerProcess = null
    processless.lease.processlessAt = NOW
    expect(
      adjudicateRestartedAgentSessionHandoff(
        processless,
        { outcome: 'reservation-unused' },
        NOW + 1_000
      ).lease
    ).toMatchObject({
      runtimeKind: 'native',
      runtimeFence: 5,
      handoffStage: null,
      handoffOperationId: null,
      claimStatus: 'released',
      reservedSpawnToken: null
    })
  })

  it.each([
    ['dead pid', { outcome: 'pid-absent' } as const],
    [
      'reused pid with a different start time',
      { outcome: 'identity-mismatch', field: 'process-start-time' } as const
    ]
  ])('releases a proving owner with exact %s proof', (_name, probe) => {
    const proving = record('new-owner-proving')
    proving.lease.runtimeKind = 'native'
    expect(adjudicateRestartedAgentSessionHandoff(proving, probe, NOW + 1_000).lease).toMatchObject(
      {
        runtimeKind: 'native',
        runtimeFence: 5,
        handoffStage: null,
        handoffOperationId: null,
        claimStatus: 'released',
        ownerProcess: null,
        reservedSpawnToken: null
      }
    )
  })

  it('preserves the existing TUI handoff rollback after proving its target dead', () => {
    expect(
      adjudicateRestartedAgentSessionHandoff(
        record('new-owner-proving'),
        { outcome: 'pid-absent' },
        NOW + 1_000
      ).lease
    ).toMatchObject({
      runtimeKind: 'native',
      runtimeFence: 5,
      handoffStage: 'old-owner-stopped',
      handoffOperationId: 'handoff-op-1'
    })
  })

  it.each([
    [
      'live exact identity',
      { outcome: 'identity-matched', matchedOn: ['process-start-time'] } as const,
      'recovering'
    ],
    [
      'indeterminate identity',
      { outcome: 'indeterminate', reason: 'start time unavailable' } as const,
      'recovering'
    ]
  ] as const)('keeps the fence and token for a %s', (_name, probe, expectedStage) => {
    const proving = record('new-owner-proving')
    proving.lease.runtimeKind = 'native'
    expect(adjudicateRestartedAgentSessionHandoff(proving, probe, NOW + 1_000).lease).toMatchObject(
      {
        runtimeFence: 4,
        handoffStage: expectedStage,
        handoffOperationId: 'handoff-op-1',
        claimStatus: 'reserved',
        ownerProcess: { pid: 4242, processStartTimeMs: NOW - 1_000 },
        reservedSpawnToken: 'spawn-restart'
      }
    )
  })
})
