import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import {
  findCommittedStructuredAgentSessionAdoptionReplay,
  findConflictingStructuredAdoption,
  resolveStructuredAgentSessionAdoption,
  structuredAdoptionConflictError,
  type StructuredAgentSessionAdoptionOwnership
} from './structured-agent-session-history-adoption'
import { PI_SESSION_HISTORY } from '../pi/pi-session-history'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'

const OPERATION = '1800000000000-00000000000000000000000000000001'

function committedReplay(overrides: { callerKey?: string; operationId?: string } = {}) {
  const lease = agentSessionLeaseFixture({ sessionId: 'codex_adopted' })
  return findCommittedStructuredAgentSessionAdoptionReplay({
    agent: 'codex',
    providerSessionId: 'thread-1',
    rowSessionId: (link) => link.handle.nativeId,
    selfSessionId: 'codex_adopted',
    callerKey: overrides.callerKey ?? 'client-1',
    operationId: overrides.operationId ?? OPERATION,
    record: {
      ...agentSessionRecordFixture(lease),
      provider: 'codex',
      providerHandleChain: [
        {
          linkId: 'codex-1-thread-1',
          origin: 'adopted',
          mintedAtFence: 1,
          observedAt: 1_800_000_000_000,
          handle: codexProviderHandle('thread-1')
        }
      ],
      accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex-original' }
    },
    operations: [
      {
        callerKey: 'client-1',
        operationId: OPERATION,
        fingerprint: 'fingerprint-1',
        operationTimestamp: 1_800_000_000_000,
        recordedAt: 1_800_000_000_000,
        expiresAt: 1_900_000_000_000,
        outcome: { status: 'succeeded', sessionId: 'codex_adopted' }
      }
    ]
  })
}

function ownership(
  overrides: Partial<StructuredAgentSessionAdoptionOwnership> = {}
): StructuredAgentSessionAdoptionOwnership {
  return {
    sessionId: 'codex_owner',
    workspaceId: 'workspace-owner',
    provider: 'codex',
    providerSessionId: 'thread-1',
    lease: agentSessionLeaseFixture(),
    ...overrides
  }
}

describe('findConflictingStructuredAdoption', () => {
  it('names the session that already holds the conversation', () => {
    const owner = ownership()

    expect(
      findConflictingStructuredAdoption({
        agent: 'codex',
        providerSessionId: 'thread-1',
        selfSessionId: 'codex_new',
        ownership: [ownership({ sessionId: 'other', providerSessionId: 'thread-2' }), owner]
      })
    ).toBe(owner)
  })

  it('exempts the requesting session, so a committed create replays instead of refusing', () => {
    expect(
      findConflictingStructuredAdoption({
        agent: 'codex',
        providerSessionId: 'thread-1',
        selfSessionId: 'codex_new',
        ownership: [ownership({ sessionId: 'codex_new' })]
      })
    ).toBeNull()
  })

  it('ignores an identical id held under the other provider', () => {
    expect(
      findConflictingStructuredAdoption({
        agent: 'claude',
        providerSessionId: 'thread-1',
        selfSessionId: 'claude_new',
        ownership: [ownership({ provider: 'codex' })]
      })
    ).toBeNull()
  })

  it('finds nothing when no session holds the conversation', () => {
    expect(
      findConflictingStructuredAdoption({
        agent: 'codex',
        providerSessionId: 'thread-unheld',
        selfSessionId: 'codex_new',
        ownership: [ownership()]
      })
    ).toBeNull()
  })
})

describe('findCommittedStructuredAgentSessionAdoptionReplay', () => {
  it('returns the record-pinned account and adopted handle for the exact committed operation', () => {
    expect(committedReplay()).toMatchObject({
      record: { accountHome: { path: '/home/dev/.codex-original' } },
      providerHandle: codexProviderHandle('thread-1')
    })
  })

  it('does not cross caller or operation namespaces', () => {
    expect(committedReplay({ callerKey: 'client-2' })).toBeNull()
    expect(committedReplay({ operationId: `${OPERATION}-other` })).toBeNull()
  })

  it('preserves the adopted Claude leaf that participated in the attach fingerprint', () => {
    const lease = agentSessionLeaseFixture({ sessionId: 'claude_adopted' })
    const record = agentSessionRecordFixture(lease)
    record.providerHandleChain[0] = {
      ...record.providerHandleChain[0]!,
      origin: 'adopted',
      handle: claudeProviderHandle('provider-session-alpha-1', 'leaf-1')
    }

    expect(
      findCommittedStructuredAgentSessionAdoptionReplay({
        agent: 'claude',
        providerSessionId: 'provider-session-alpha-1',
        rowSessionId: (link) => link.handle.nativeId,
        selfSessionId: 'claude_adopted',
        callerKey: 'client-1',
        operationId: OPERATION,
        record,
        operations: [
          {
            callerKey: 'client-1',
            operationId: OPERATION,
            fingerprint: 'fingerprint-1',
            operationTimestamp: 1_800_000_000_000,
            recordedAt: 1_800_000_000_000,
            expiresAt: 1_900_000_000_000,
            outcome: { status: 'succeeded', sessionId: 'claude_adopted' }
          }
        ]
      })
    ).toMatchObject({
      providerHandle: claudeProviderHandle('provider-session-alpha-1', 'leaf-1')
    })
  })
})

describe('replaying a Pi adoption, whose handle names its session file', () => {
  it("matches the row id the agent's Session History shows the file as", () => {
    const file =
      '/home/dev/.pi/agent/sessions/--repo--/2026-10-12T00-00-00-000Z_0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a.jsonl'
    const lease = agentSessionLeaseFixture({ sessionId: 'pi_adopted' })
    const record = agentSessionRecordFixture(lease)
    record.provider = 'pi'
    record.providerHandleChain[0] = {
      ...record.providerHandleChain[0]!,
      origin: 'adopted',
      handle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: file }
    }
    const replay = (providerSessionId: string) =>
      findCommittedStructuredAgentSessionAdoptionReplay({
        agent: 'pi',
        providerSessionId,
        rowSessionId: PI_SESSION_HISTORY.rowSessionId,
        selfSessionId: 'pi_adopted',
        callerKey: 'client-1',
        operationId: OPERATION,
        record,
        operations: [
          {
            callerKey: 'client-1',
            operationId: OPERATION,
            fingerprint: 'fingerprint-1',
            operationTimestamp: 1_800_000_000_000,
            recordedAt: 1_800_000_000_000,
            expiresAt: 1_900_000_000_000,
            outcome: { status: 'succeeded', sessionId: 'pi_adopted' }
          }
        ]
      })

    expect(replay('0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a')).toMatchObject({
      providerHandle: { nativeId: file }
    })
    expect(replay('0198c2a4-7d1e-7c3a-9a4b-000000000000')).toBeNull()
  })
})

describe('structuredAdoptionConflictError', () => {
  it('calls a conversation with an admitted writer a conflict', () => {
    expect(structuredAdoptionConflictError(ownership()).message).toBe('agent_session_conflict')
  })

  it.each([
    ['a reservation with no process yet', { ownerProcess: null, claimStatus: 'reserved' as const }],
    ['a lease mid-handoff', { handoffStage: 'new-owner-proving' as const }],
    ['an unreconciled lease', { unreconciled: true }]
  ])('calls %s an unknown owner rather than a conflict', (_label, leaseOverrides) => {
    // Neither verdict admits a second writer; they differ only in what the user is told.
    expect(
      structuredAdoptionConflictError(
        ownership({ lease: agentSessionLeaseFixture(leaseOverrides) })
      ).message
    ).toBe('agent_session_ownership_unknown')
  })
})

describe('resolveStructuredAgentSessionAdoption', () => {
  it('refuses rather than falling back to a home that does not hold the conversation', async () => {
    // A resume under the wrong home lands in a blank chat wearing the old chat's name.
    await expect(
      resolveStructuredAgentSessionAdoption({
        providerSessionId: 'session-1',
        candidateAccountHomes: [
          { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
          { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' }
        ],
        resolveTranscript: async () => null,
        launchEnv: {},
        workspaceCwd: '/repo'
      })
    ).rejects.toThrow('agent_session_identity_required')
  })
})
