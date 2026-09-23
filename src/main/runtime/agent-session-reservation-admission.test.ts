// Adoption admission inside the reservation transaction: which conversation a new record may claim.

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
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
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

/** The link an adopting create seeds: fence 1, because that is a new record's first. */
function adoptedLink(
  overrides: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId: 'claude-1-provider-session-alpha-1-empty',
    handle: { provider: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: null },
    origin: 'adopted',
    mintedAtFence: 1,
    observedAt: NOW,
    ...overrides
  }
}

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-adopting',
    location: LOCATION,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    runtimeKind: 'native',
    expectedFence: null,
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
    visibleSessionIds: new Set(),
    visibleSessionIdsIndexPresent: true
  }
}

describe('adopted handle chain seeding', () => {
  it('seeds a new record with the adopted link alone, at the first fence of the record', () => {
    const link = adoptedLink()
    const { record, disposition } = applyAgentSessionReservation(
      storeState(),
      reserveRequest({ adoptedHandleLink: link }),
      LEASE_TTL_MS
    )

    expect(disposition).toBe('created')
    expect(record.providerHandleChain).toEqual([link])
    // The owner probe requires the head link to carry the record's current fence.
    expect(record.providerHandleChain[0]?.mintedAtFence).toBe(record.lease.runtimeFence)
  })

  it('leaves a blank create with no chain, so the adapter starts a conversation', () => {
    const { record } = applyAgentSessionReservation(storeState(), reserveRequest(), LEASE_TTL_MS)

    expect(record.providerHandleChain).toEqual([])
  })
})

describe('adopted conversation ownership', () => {
  it('refuses when another record already holds the same conversation root', () => {
    // The held link names a leaf; the adoption names none. Same root is the whole test: keying on
    // the exact handle would let two writers onto one conversation on different branches.
    const holder = agentSessionRecordFixture()

    expect(() =>
      applyAgentSessionReservation(
        storeState([holder]),
        reserveRequest({ adoptedHandleLink: adoptedLink() }),
        LEASE_TTL_MS
      )
    ).toThrow('agent_session_conflict')
  })

  it('admits an adoption of a conversation no record holds', () => {
    const holder = agentSessionRecordFixture()

    expect(() =>
      applyAgentSessionReservation(
        storeState([holder]),
        reserveRequest({
          adoptedHandleLink: adoptedLink({
            handle: { provider: 'claude', sessionId: 'provider-session-other', leafUuid: null }
          })
        }),
        LEASE_TTL_MS
      )
    ).not.toThrow()
  })

  it('exempts the requesting session so a committed create can be re-run', () => {
    // Pins the guard's own contract. No wire shape reaches it today: `adopt` is accepted only on
    // create-by-intent, which always carries a null expected fence, and an existing record with a
    // null expected fence is refused a few lines below anyway.
    const link = adoptedLink()
    const committed: AgentSessionRecord = {
      ...agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId: 'session-adopting',
          runtimeFence: 1,
          handoffStage: 'new-owner-proving',
          claimStatus: 'reserved',
          ownerProcess: null,
          provenHandleLinkId: null,
          handoffOperationId: 'handoff-1'
        })
      ),
      location: LOCATION,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
      providerHandleChain: [link]
    }

    const { record, disposition } = applyAgentSessionReservation(
      storeState([committed]),
      reserveRequest({
        adoptedHandleLink: link,
        expectedFence: 1,
        handoffOperationId: 'handoff-1'
      }),
      LEASE_TTL_MS
    )

    expect(disposition).toBe('retry-reservation')
    expect(record.providerHandleChain).toEqual([link])
  })

  it('refuses a Codex adoption another record already holds', () => {
    const holder: AgentSessionRecord = {
      ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'session-codex' })),
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
      providerHandleChain: [
        {
          linkId: 'codex-1-thread-1',
          handle: { provider: 'codex', threadId: 'thread-1' },
          origin: 'created',
          mintedAtFence: 7,
          observedAt: NOW
        }
      ]
    }

    expect(() =>
      applyAgentSessionReservation(
        storeState([holder]),
        reserveRequest({
          sessionId: 'session-codex-adopting',
          provider: 'codex',
          accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
          adoptedHandleLink: adoptedLink({
            linkId: 'codex-1-thread-1-adopted',
            handle: { provider: 'codex', threadId: 'thread-1' }
          })
        }),
        LEASE_TTL_MS
      )
    ).toThrow('agent_session_conflict')
  })
})

describe('re-attach account identity', () => {
  /** Deliberately NOT relaxed for a bound record: a group whose binding changed between attaches
   *  is a different account, and silently re-attaching to it is the fork this refuses. */
  it('refuses a re-attach whose account home path changed', () => {
    const existing: AgentSessionRecord = {
      ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'session-bound' })),
      location: LOCATION,
      provider: 'claude',
      accountHome: {
        variable: 'CLAUDE_CONFIG_DIR',
        path: '/bound/group-a',
        binding: { kind: 'project-group', groupId: 'group-a' }
      },
      providerHandleChain: []
    }

    expect(() =>
      applyAgentSessionReservation(
        storeState([existing]),
        reserveRequest({
          sessionId: 'session-bound',
          provider: 'claude',
          expectedFence: existing.lease.runtimeFence,
          accountHome: {
            variable: 'CLAUDE_CONFIG_DIR',
            path: '/bound/group-b',
            binding: { kind: 'project-group', groupId: 'group-b' }
          }
        }),
        LEASE_TTL_MS
      )
    ).toThrow('agent_session_conflict')
  })

  /** The marker decides which safety gates a launch runs, so acquiring it across a re-attach is an
   *  account change in its own right even when the path never moves. */
  it.each([
    [
      'attaching a binding to an unbound record',
      undefined,
      { kind: 'project-group', groupId: 'g' }
    ],
    ['dropping the binding', { kind: 'project-group', groupId: 'g' }, undefined],
    [
      'changing the bound group',
      { kind: 'project-group', groupId: 'g' },
      { kind: 'project-group', groupId: 'other' }
    ]
  ] as const)('refuses a re-attach at the same path %s', (_name, before, after) => {
    const existing: AgentSessionRecord = {
      ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'session-marker' })),
      location: LOCATION,
      provider: 'claude',
      accountHome: {
        variable: 'CLAUDE_CONFIG_DIR',
        path: '/bound/group-a',
        ...(before ? { binding: before } : {})
      },
      providerHandleChain: []
    }

    expect(() =>
      applyAgentSessionReservation(
        storeState([existing]),
        reserveRequest({
          sessionId: 'session-marker',
          provider: 'claude',
          expectedFence: existing.lease.runtimeFence,
          accountHome: {
            variable: 'CLAUDE_CONFIG_DIR',
            path: '/bound/group-a',
            ...(after ? { binding: after } : {})
          }
        }),
        LEASE_TTL_MS
      )
    ).toThrow('agent_session_conflict')
  })
})
