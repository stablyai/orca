import { describe, expect, it } from 'vitest'
import { eligibleStructuredCommandDetail } from './structured-command-detail-eligibility'
import type { AgentChildWorkRecord } from '../../../../shared/agent-status/child-work/agent-status-child-work'
import { createStructuredCommandOccurrence } from './structured-command-occurrence'

const TUPLE = { childWorkId: 'cmd', invocationId: 'run', generation: 2 }

function record(extra: Partial<AgentChildWorkRecord> = {}): AgentChildWorkRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  return {
    childWorkId: 'cmd',
    kind: 'command',
    residency: 'background',
    provenance: { source: 'structured-session', producerId: 'p' },
    invocation: { invocationId: 'run', generation: 2 },
    ...extra
  } as AgentChildWorkRecord
}

const slot = (fence = 5) => ({
  fence,
  occurrence: new WeakRef(createStructuredCommandOccurrence('make')),
  display: 'make'
})

function conversation(currentFence = 5, owner: Record<string, unknown> = {}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  return {
    provider: 'codex',
    currentFence,
    ownerObservation: {
      claimStatus: 'live',
      unreconciled: false,
      ownerProcess: { pid: 1 },
      reservedSpawnToken: null,
      handoffStage: null,
      deathEvidence: null,
      ...owner
    }
  } as never
}

const read = (input: Partial<Parameters<typeof eligibleStructuredCommandDetail>[0]> = {}) =>
  eligibleStructuredCommandDetail({
    conversation: conversation(),
    membershipCurrent: true,
    detail: { record: record(), slot: slot() },
    tuple: TUPLE,
    ...input
  })

describe('eligibleStructuredCommandDetail', () => {
  it('returns the exact command only for this current background Codex command', () => {
    expect(read()).toBe('make')
  })

  it('refuses every mismatch', () => {
    expect(read({ conversation: null })).toBeNull()
    expect(read({ membershipCurrent: false })).toBeNull()
    expect(read({ detail: null })).toBeNull()
    expect(read({ detail: { record: record(), slot: undefined } })).toBeNull()
    expect(read({ tuple: { ...TUPLE, generation: 1 } })).toBeNull()
    expect(read({ tuple: { ...TUPLE, invocationId: 'other' } })).toBeNull()
    expect(read({ detail: { record: record({ kind: 'agent' }), slot: slot() } })).toBeNull()
    expect(
      read({ detail: { record: record({ residency: 'foreground' }), slot: slot() } })
    ).toBeNull()
    expect(
      read({
        detail: {
          record: record({ provenance: { source: 'hook', producerId: 'p' } }),
          slot: slot()
        }
      })
    ).toBeNull()
    expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
      read({ conversation: { ...(conversation() as object), provider: 'claude' } as never })
    ).toBeNull()
  })

  it('a moved owner fence revokes, except the proven release of that same acquisition', () => {
    expect(read({ conversation: conversation(6) })).toBeNull()
    const released = {
      unreconciled: false,
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null,
      handoffStage: null,
      deathEvidence: { kind: 'exit-observed', detail: '', observedAt: 1, ownerFence: 5 }
    }
    expect(read({ conversation: conversation(6, released) })).toBe('make')
    expect(
      read({
        conversation: conversation(6, {
          ...released,
          deathEvidence: { ...released.deathEvidence, ownerFence: 4 }
        })
      })
    ).toBeNull()
    expect(
      read({ conversation: conversation(6, { ...released, reservedSpawnToken: 'next' }) })
    ).toBeNull()
    expect(
      read({ conversation: conversation(6, { ...released, handoffStage: 'recovering' }) })
    ).toBeNull()
  })

  it('an equal fence needs a live, reconciled owner: a same-fence recovery or reservation revokes', () => {
    // The real unproven post-acquisition settlement: same fence and process, parked in recovery.
    expect(
      read({
        conversation: conversation(5, {
          claimStatus: 'live',
          handoffStage: 'recovering',
          handoffOperationId: null,
          reservedSpawnToken: 'spawn-1'
        })
      })
    ).toBeNull()
    expect(read({ conversation: conversation(5, { unreconciled: true }) })).toBeNull()
    expect(
      read({ conversation: conversation(5, { handoffStage: 'new-owner-proving' }) })
    ).toBeNull()
    expect(
      read({
        conversation: conversation(5, {
          claimStatus: 'reserved',
          ownerProcess: null,
          reservedSpawnToken: 'next'
        })
      })
    ).toBeNull()
    expect(read({ conversation: conversation(5, { ownerProcess: null }) })).toBeNull()
    expect(read({ conversation: conversation(5, { claimStatus: 'released' }) })).toBeNull()
    // Control: the same fence with its live owner still reads.
    expect(read({ conversation: conversation(5) })).toBe('make')
  })

  it('a proven release of that acquisition still needs a reconciled record', () => {
    const released = {
      unreconciled: true,
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null,
      handoffStage: null,
      deathEvidence: { kind: 'exit-observed', detail: '', observedAt: 1, ownerFence: 5 }
    }
    expect(read({ conversation: conversation(6, released) })).toBeNull()
    expect(read({ conversation: conversation(6, { ...released, unreconciled: false }) })).toBe(
      'make'
    )
    // A newer reservation on top of the proven release revokes it.
    expect(
      read({
        conversation: conversation(6, {
          ...released,
          unreconciled: false,
          claimStatus: 'reserved',
          reservedSpawnToken: 'next'
        })
      })
    ).toBeNull()
  })
})
