import { describe, expect, it } from 'vitest'
import type { StructuredPointerOperationRow } from './db/messages/structured-pointer-operation-store'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS
} from '../../../shared/agent-session-host-authority'
import {
  decideStructuredPointerAttempt,
  mintAgentSessionOperationId,
  resolveStructuredPointerOperation,
  structuredPointerBatchFingerprint,
  type StructuredPointerOperationStore,
  type StructuredPointerSubmission
} from './structured-pointer-operation-id'

const OPERATION_ID_PATTERN = /^\d{13}-[0-9a-f]{32}$/

/** The id this batch resolves to, as this process sends it; unrecorded unless `submissions` say. */
function resolveId(
  args: Omit<
    Parameters<typeof resolveStructuredPointerOperation>[0],
    'submissions' | 'sentByThisProcess'
  > & { submissions?: StructuredPointerSubmission[] }
): {
  operationId: string
} {
  const resolved = resolveStructuredPointerOperation({
    ...args,
    submissions: args.submissions ?? [],
    sentByThisProcess: args.db.getStructuredPointerOperation(args.mailboxHandle)?.operation_id
  })
  if (resolved.kind !== 'send') {
    throw new Error(`expected a send, got ${resolved.kind}`)
  }
  return resolved
}

function fakeDb(): StructuredPointerOperationStore {
  const rows = new Map<string, StructuredPointerOperationRow>()
  return {
    getStructuredPointerOperation: (handle: string) => rows.get(handle),
    putStructuredPointerOperation: (row: StructuredPointerOperationRow) =>
      rows.set(row.mailbox_handle, row)
  }
}

describe('structured pointer operation id', () => {
  it('mints ids the host will admit', () => {
    // Orchestration's own msg_<hex> ids do not match and are refused before the first send.
    expect(mintAgentSessionOperationId(Date.now())).toMatch(OPERATION_ID_PATTERN)
  })

  it('reuses one id for the same batch', () => {
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const second = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m1', 'm2'],
      now: 2_000
    })
    expect(second.operationId).toBe(first.operationId)
  })

  it('re-mints when the batch grows', () => {
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const grown = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m1', 'm2', 'm3'],
      now: 1_500
    })
    expect(grown.operationId).not.toBe(first.operationId)
  })

  it('never re-mints an ambiguous batch after the host replay window expires', () => {
    // The host recorded the send `unknown`: whether the nudge landed is still open, however old.
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const aged = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m1', 'm2'],
      submissions: [
        { clientMessageId: first.operationId, dispatchState: 'unknown', submittedAt: 1_000 }
      ],
      now: 1_000 + AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS + 1
    })
    expect(aged.operationId).toBe(first.operationId)
  })

  it('re-mints for a different batch of the same size', () => {
    // The pointer body names only how many messages are waiting, so two unrelated same-size
    // batches share a payload fingerprint. Reusing the live id across them makes the host replay
    // its ledger answer — `accepted`, with no turn sent — and the lane then marks the NEW mail
    // delivered. The worker is never told, and the mail is gone.
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const different = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m3', 'm4'],
      now: 1_100
    })
    expect(different.operationId).not.toBe(first.operationId)
  })

  it('re-mints when a retained batch is reordered or partly consumed', () => {
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const shifted = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m2', 'm3'],
      now: 1_100
    })
    expect(shifted.operationId).not.toBe(first.operationId)
  })

  it('re-mints when the mailbox moves to a different session', () => {
    const db = fakeDb()
    const first = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's1',
      messageIds: ['m1', 'm2'],
      now: 1_000
    })
    const moved = resolveId({
      db,
      mailboxHandle: 'dispatch:d1',
      sessionId: 's2',
      messageIds: ['m1', 'm2'],
      now: 1_100
    })
    expect(moved.operationId).not.toBe(first.operationId)
  })

  it.each(['pending', 'accepted'] as const)(
    'retains a changed batch when a legacy %s submission cannot identify original members',
    (dispatchState) => {
      const db = fakeDb()
      const input = { db, mailboxHandle: 'dispatch:d1', sessionId: 's1', now: 1_000 }
      const first = resolveId({ ...input, messageIds: ['m1', 'm2'] })
      expect(
        resolveStructuredPointerOperation({
          ...input,
          messageIds: ['m2'],
          submissions: [{ clientMessageId: first.operationId, dispatchState, submittedAt: 1_000 }],
          sentByThisProcess: first.operationId
        })
      ).toEqual({ kind: 'park' })
      expect(db.getStructuredPointerOperation('dispatch:d1')?.operation_id).toBe(first.operationId)
    }
  )

  it('stamps the original proven batch rather than an eligible subset', () => {
    const db = fakeDb()
    const input = { db, mailboxHandle: 'dispatch:d1', sessionId: 's1', now: 1_000 }
    const first = resolveId({ ...input, messageIds: ['m1', 'm2'] })
    expect(
      resolveStructuredPointerOperation({
        ...input,
        messageIds: ['m2'],
        submissions: [
          {
            clientMessageId: first.operationId,
            dispatchState: 'accepted',
            submittedAt: 1_000,
            mailNotice: { mailbox: 'dispatch:d1', messageIds: ['m1', 'm2'] }
          }
        ],
        sentByThisProcess: first.operationId
      })
    ).toEqual({ kind: 'stamp', messageIds: ['m1', 'm2'] })
  })

  it('settles queue acceptance across actor and session changes using the original fingerprint', () => {
    const db = fakeDb()
    const input = { db, mailboxHandle: 'dispatch:d1', sessionId: 's1', now: 1_000 }
    const first = resolveId({ ...input, messageIds: ['m1', 'm2'] })
    expect(
      resolveStructuredPointerOperation({
        ...input,
        sessionId: 'successor',
        messageIds: ['m2'],
        submissions: [],
        queuedSends: [
          {
            operationId: first.operationId,
            mailNotice: { mailbox: 'dispatch:d1', messageIds: ['m1', 'm2'] }
          }
        ],
        sentByThisProcess: undefined
      })
    ).toEqual({ kind: 'stamp', messageIds: ['m1', 'm2'] })
  })

  it('retains queue acceptance with unverifiable original provenance instead of minting a duplicate', () => {
    const db = fakeDb()
    const input = { db, mailboxHandle: 'dispatch:d1', sessionId: 's1', now: 1_000 }
    const first = resolveId({ ...input, messageIds: ['m1', 'm2'] })
    expect(
      resolveStructuredPointerOperation({
        ...input,
        messageIds: ['m2'],
        submissions: [],
        queuedSends: [{ operationId: first.operationId }],
        sentByThisProcess: undefined
      })
    ).toEqual({ kind: 'park' })
    expect(db.getStructuredPointerOperation('dispatch:d1')?.operation_id).toBe(first.operationId)
  })

  it('admits independent messages without replacing an overlapping pending notice', () => {
    const db = fakeDb()
    const input = { db, mailboxHandle: 'dispatch:d1', sessionId: 's1', now: 1_000 }
    const first = resolveId({ ...input, messageIds: ['m1', 'm2'] })
    const submissions: StructuredPointerSubmission[] = [
      {
        clientMessageId: first.operationId,
        dispatchState: 'pending',
        submittedAt: 1_000,
        mailNotice: { mailbox: 'dispatch:d1', messageIds: ['m1', 'm2'] }
      }
    ]
    expect(
      resolveStructuredPointerOperation({
        ...input,
        messageIds: ['m2', 'm3'],
        submissions,
        sentByThisProcess: first.operationId
      })
    ).toEqual({ kind: 'park' })
    const independent = resolveId({ ...input, messageIds: ['m3'], submissions })
    expect(independent.operationId).not.toBe(first.operationId)
  })

  it('requires mailbox and fingerprint agreement before trusting projected original IDs', () => {
    const db = fakeDb()
    const input = { db, mailboxHandle: 'dispatch:d1', sessionId: 's1', now: 1_000 }
    const first = resolveId({ ...input, messageIds: ['m1', 'm2'] })
    for (const mailNotice of [
      { mailbox: 'dispatch:other', messageIds: ['m1', 'm2'] },
      { mailbox: 'dispatch:d1', messageIds: ['m2'] }
    ]) {
      expect(
        resolveStructuredPointerOperation({
          ...input,
          messageIds: ['m3'],
          submissions: [
            {
              clientMessageId: first.operationId,
              dispatchState: 'accepted',
              submittedAt: 1_000,
              mailNotice
            }
          ],
          sentByThisProcess: first.operationId
        })
      ).toEqual({ kind: 'park' })
    }
  })

  it('releases legacy acceptance uncertainty once its owning journal turn settles', () => {
    const db = fakeDb()
    const input = { db, mailboxHandle: 'dispatch:d1', sessionId: 's1', now: 1_000 }
    const first = resolveId({ ...input, messageIds: ['m1', 'm2'] })
    const next = resolveId({
      ...input,
      messageIds: ['m2'],
      submissions: [
        {
          clientMessageId: first.operationId,
          dispatchState: 'accepted',
          submittedAt: 1_000,
          turnSettled: true
        }
      ]
    })
    expect(next.operationId).not.toBe(first.operationId)
    expect(db.getStructuredPointerOperation('dispatch:d1')?.batch_fingerprint).toBe(
      structuredPointerBatchFingerprint('s1', ['m2'])
    )
  })
})

describe('what a pointer attempt does with its operation row', () => {
  const row = {
    mailbox_handle: 'run:r1',
    session_id: 's1',
    operation_id: 'op1',
    batch_fingerprint: 'batch-1',
    minted_at_ms: 2_000
  }

  function decide(
    submissions: StructuredPointerSubmission[],
    overrides: {
      batchFingerprint?: string
      sessionId?: string
      mintedByThisProcess?: boolean
      now?: number
    } = {}
  ) {
    return decideStructuredPointerAttempt({
      row,
      sessionId: overrides.sessionId ?? 's1',
      batchFingerprint: overrides.batchFingerprint ?? 'batch-1',
      submissions,
      mintedByThisProcess: overrides.mintedByThisProcess ?? true,
      now: overrides.now ?? 3_000
    })
  }

  const sent = (dispatchState: StructuredPointerSubmission['dispatchState']) => ({
    clientMessageId: 'op1',
    dispatchState,
    submittedAt: 2_000
  })
  const userTurn = (dispatchState: StructuredPointerSubmission['dispatchState'], at = 2_500) => ({
    clientMessageId: 'user-1',
    dispatchState,
    submittedAt: at
  })

  it('mints for a new batch, a new session, or no row at all', () => {
    expect(decide([], { batchFingerprint: 'batch-2' })).toBe('mint')
    expect(decide([], { sessionId: 's2' })).toBe('mint')
    expect(
      decideStructuredPointerAttempt({
        row: undefined,
        sessionId: 's1',
        batchFingerprint: 'batch-1',
        submissions: [],
        mintedByThisProcess: false,
        now: 0
      })
    ).toBe('mint')
  })

  it('sends under the same id when the host never recorded it', () => {
    expect(decide([])).toBe('reuse')
    // A turn that ran before the row was minted is no news.
    expect(decide([userTurn('accepted', 1_500)])).toBe('reuse')
  })

  it('stamps a send that ran, and parks one still in flight', () => {
    expect(decide([sent('accepted')])).toBe('stamp')
    expect(decide([sent('pending')])).toBe('park')
  })

  it.each([
    ['pending', 'park'],
    ['accepted', 'stamp']
  ] as const)(
    'reconciles a %s operation before comparing changed membership',
    (state, expected) => {
      expect(decide([sent(state)], { batchFingerprint: 'batch-2' })).toBe(expected)
    }
  )

  it.each([
    ['in doubt', sent('unknown')],
    ['refused', sent('rejected')]
  ])('replays a send that was %s instead of starting the agent again', (_label, failed) => {
    expect(decide([failed])).toBe('reuse')
    // A later send that has not run yet is no evidence the agent works again.
    expect(decide([failed, userTurn('pending')])).toBe('reuse')
    // Age never re-mints a recorded send.
    expect(decide([failed], { now: 2_000 + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + 1 })).toBe(
      'reuse'
    )
  })

  it('mints once the agent ran a turn after the row was minted, recorded send or not', () => {
    expect(decide([sent('unknown'), userTurn('accepted')])).toBe('mint')
    expect(decide([sent('rejected'), userTurn('accepted')])).toBe('mint')
    // A rewind dropped the row's own send from the journal.
    expect(decide([userTurn('accepted')])).toBe('mint')
  })

  it('mints a row an earlier process left behind, recorded send or not', () => {
    expect(decide([sent('unknown')], { mintedByThisProcess: false })).toBe('mint')
    expect(decide([], { mintedByThisProcess: false })).toBe('mint')
  })

  it('mints an unrecorded send once the host would refuse it as too old to admit', () => {
    expect(decide([], { now: 2_000 + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS })).toBe('reuse')
    expect(decide([], { now: 2_000 + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + 1 })).toBe('mint')
  })
})
