import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { adjudicateRestartedAgentSessionHandoff } from './agent-session-restart-handoff-adjudication'

const NOW = 1_800_000_000_000

function record(stage: 'preparing' | 'new-owner-proving'): AgentSessionRecord {
  return {
    schemaVersion: 1,
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

  it('rolls a dead proving target back to the source kind before retry', () => {
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
})
