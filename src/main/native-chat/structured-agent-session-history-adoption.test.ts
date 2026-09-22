import { describe, expect, it, vi } from 'vitest'
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

const OPERATION = '1800000000000-00000000000000000000000000000001'

function committedReplay(overrides: { callerKey?: string; operationId?: string } = {}) {
  const lease = agentSessionLeaseFixture({ sessionId: 'codex_adopted' })
  return findCommittedStructuredAgentSessionAdoptionReplay({
    agent: 'codex',
    providerSessionId: 'thread-1',
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
          handle: { provider: 'codex', threadId: 'thread-1' }
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
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
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
      handle: {
        provider: 'claude',
        sessionId: 'provider-session-alpha-1',
        leafUuid: 'leaf-1'
      }
    }

    expect(
      findCommittedStructuredAgentSessionAdoptionReplay({
        agent: 'claude',
        providerSessionId: 'provider-session-alpha-1',
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
      providerHandle: {
        kind: 'claude',
        sessionId: 'provider-session-alpha-1',
        leafUuid: 'leaf-1'
      }
    })
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
  it('takes the first candidate home that holds the transcript and probes no further', async () => {
    const resolveTranscript = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/home/dev/.codex/sessions/thread-1.jsonl')

    await expect(
      resolveStructuredAgentSessionAdoption({
        agent: 'codex',
        providerSessionId: 'thread-1',
        candidateAccountHomes: ['/home/dev/.orca-codex', '/home/dev/.codex', '/never/probed'],
        resolveTranscript
      })
    ).resolves.toEqual({
      accountHomePath: '/home/dev/.codex',
      transcriptPath: '/home/dev/.codex/sessions/thread-1.jsonl'
    })
    expect(resolveTranscript).toHaveBeenCalledTimes(2)
  })

  it('skips blank and repeated candidates instead of probing them again', async () => {
    const resolveTranscript = vi.fn().mockResolvedValue(null)

    await expect(
      resolveStructuredAgentSessionAdoption({
        agent: 'claude',
        providerSessionId: 'session-1',
        candidateAccountHomes: ['', '   ', '/home/dev/.claude', ' /home/dev/.claude ', ''],
        resolveTranscript
      })
    ).rejects.toThrow('agent_session_identity_required')
    expect(resolveTranscript.mock.calls.map(([args]) => args.accountHomePath)).toEqual([
      '/home/dev/.claude'
    ])
  })

  it('refuses rather than falling back to a home that does not hold the conversation', async () => {
    // A resume under the wrong home lands in a blank chat wearing the old chat's name.
    await expect(
      resolveStructuredAgentSessionAdoption({
        agent: 'claude',
        providerSessionId: 'session-1',
        candidateAccountHomes: ['/home/dev/.claude-work', '/home/dev/.claude'],
        resolveTranscript: async () => null
      })
    ).rejects.toThrow('agent_session_identity_required')
  })
})
