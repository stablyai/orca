// How a stored dispatch row's answered turn reads onto its submission: a named turn, none stated,
// or absent on a row written before the field existed.

import { describe, expect, it } from 'vitest'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

const EPOCH = 'epoch-1'

function base(seq: number): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: 1, epoch: EPOCH, seq, fence: 1, ts: 1_000 + seq }
}

/** The submission after a send and one dispatch row, stored with the given extra keys. */
function readAfter(dispatch: Partial<Extract<JournalRow, { kind: 'dispatch' }>>) {
  const state = createJournalReducerState('session-1', EPOCH)
  applyJournalRow(state, {
    kind: 'submission',
    clientMessageId: 'cm_1',
    payloadFingerprint: 'fp_1',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ...base(1)
  })
  applyJournalRow(state, {
    kind: 'dispatch',
    clientMessageId: 'cm_1',
    state: 'rejected',
    providerItemId: null,
    reason: 'This message was withdrawn before the agent started it.',
    ...base(2),
    ...dispatch
  })
  return state.submissions.get('cm_1')
}

describe("a rejected dispatch row's answered turn", () => {
  it('is the turn it names', () => {
    expect(readAfter({ answeredInTurn: { turnItemId: 'turn-1', via: 'steer' } })).toMatchObject({
      answeredInTurn: { turnItemId: 'turn-1', via: 'steer' }
    })
  })

  it('is none when the row states none', () => {
    expect(readAfter({ answeredInTurn: null })).toMatchObject({ answeredInTurn: null })
  })

  it('is absent on a row written before the field existed', () => {
    const submission = readAfter({})

    expect(submission).toMatchObject({ dispatchState: 'rejected' })
    expect(submission).not.toHaveProperty('answeredInTurn')
  })

  it('reads as none, keeping the row, when it names a way of joining this build does not know', () => {
    expect(readAfter({ answeredInTurn: { turnItemId: 'turn-1', via: 'resume' } })).toMatchObject({
      dispatchState: 'rejected',
      answeredInTurn: null
    })
  })

  it('reads as none, keeping the row, when it names no turn id', () => {
    expect(readAfter({ answeredInTurn: { turnItemId: '', via: 'start' } })).toMatchObject({
      dispatchState: 'rejected',
      answeredInTurn: null
    })
  })

  it('is absent on any other dispatch state', () => {
    const submission = readAfter({
      state: 'unknown',
      answeredInTurn: { turnItemId: 'turn-1', via: 'start' }
    })

    expect(submission).toMatchObject({ dispatchState: 'unknown' })
    expect(submission).not.toHaveProperty('answeredInTurn')
  })
})
