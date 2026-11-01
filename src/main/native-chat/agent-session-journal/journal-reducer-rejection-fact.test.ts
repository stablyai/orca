import { describe, expect, it } from 'vitest'
import {
  classifyDispatchRejection,
  DISPATCH_REJECTED_QUEUE_FULL
} from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

const EPOCH = 'epoch-1'

function base(seq: number): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: 1, epoch: EPOCH, seq, fence: 1, ts: 1_000 + seq }
}

function fold(rows: JournalRow[]): JournalReducerState {
  const state = createJournalReducerState('session-1', EPOCH)
  for (const row of rows) {
    applyJournalRow(state, row)
  }
  return state
}

describe('a rejected dispatch', () => {
  const submission: JournalRow = {
    kind: 'submission',
    clientMessageId: 'cm_1',
    payloadFingerprint: 'fp_1',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ...base(1)
  }

  it('keeps only the kind of a rejection fact it cannot place, so it reads as no verdict', () => {
    const rejected = (rejection: unknown): JournalRow => {
      const row: JournalRow = {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'rejected',
        providerItemId: null,
        reason: DISPATCH_REJECTED_QUEUE_FULL,
        ...base(2)
      }
      return Object.assign(row, { rejection })
    }
    // Unknown typed facts must not fall back to conflicting reason markers.
    const newer = fold([submission, rejected({ kind: 'futureKind', detail: 'x' })])
    const settled = newer.submissions.get('cm_1')
    expect(settled).toMatchObject({ dispatchState: 'rejected', rejection: { kind: 'futureKind' } })
    expect(settled && classifyDispatchRejection(settled)).toEqual({
      category: 'undelivered',
      verdict: null
    })
    const malformed = fold([submission, rejected('queueFull')]).submissions.get('cm_1')
    expect(malformed).not.toHaveProperty('rejection')
    expect(malformed && classifyDispatchRejection(malformed)).toMatchObject({ kind: 'queueFull' })
  })
})
