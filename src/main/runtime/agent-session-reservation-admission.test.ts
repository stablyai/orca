// Reservation admission for an agent start: the record its create founded, at the fence the start
// read. Founding, adoption and tab ids are the create's; see agent-session-at-rest-create.

import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import {
  applyAgentSessionReservation,
  type AgentSessionReserveRequest
} from './agent-session-reservation-admission'
import type { AgentSessionStoreState } from './agent-session-record-store-file'

const NOW = 1_800_000_000_000
const LEASE_TTL_MS = 60_000

const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-starting',
    location: LOCATION,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    expectedFence: 2,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: { callerKey: 'client-1', operationId: 'op-1', fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

function storeState(records: readonly AgentSessionRecord[] = []): AgentSessionStoreState {
  return {
    schemaVersion: 2,
    hostId: 'local',
    records: new Map(records.map((record) => [record.sessionId, record])),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    sessionTabs: null
  }
}

/** A record whose last start ended and released its lease at fence 2. */
function released(): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: 'session-starting',
        runtimeKind: 'native',
        runtimeFence: 2,
        provenHandleLinkId: null,
        ownerProcess: null,
        reservedSpawnToken: null,
        claimStatus: 'released',
        deathEvidence: { kind: 'exit-observed', detail: 'the start failed', observedAt: 1 }
      })
    ),
    location: LOCATION,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    providerHandleChain: []
  }
}

describe('reserving a start', () => {
  it('refuses a session no create founded, and one whose record this build cannot read', () => {
    expect(() =>
      applyAgentSessionReservation(storeState(), reserveRequest(), LEASE_TTL_MS)
    ).toThrow('agent_session_checkpoint_stale')
    const unreadable = storeState()
    unreadable.unreadableRecords.set('session-starting', { reason: 'invalid', raw: {} })
    expect(() => applyAgentSessionReservation(unreadable, reserveRequest(), LEASE_TTL_MS)).toThrow(
      'execution_owner_reconciling'
    )
  })

  it('reserves a released record one fence past the fence its start read', () => {
    const { record, disposition } = applyAgentSessionReservation(
      storeState([released()]),
      reserveRequest(),
      LEASE_TTL_MS
    )

    expect(disposition).toBe('reserved')
    expect(record.lease).toMatchObject({ claimStatus: 'reserved', runtimeFence: 3 })
  })

  it('refuses a start that read a fence the record has since left', () => {
    expect(() =>
      applyAgentSessionReservation(
        storeState([released()]),
        reserveRequest({ expectedFence: 1 }),
        LEASE_TTL_MS
      )
    ).toThrow('agent_session_checkpoint_stale')
  })
})
