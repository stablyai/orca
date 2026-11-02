import { describe, expect, it } from 'vitest'
import { findSequenceGap, resolveJournalResume, type JournalCursorRange } from './journal-cursor'

const RANGE: JournalCursorRange = { epoch: 'e1', lastSequence: 40, oldestSequence: 11 }

describe('resolveJournalResume', () => {
  it('resumes from a cursor sitting exactly on the compaction boundary', () => {
    expect(resolveJournalResume(RANGE, { epoch: 'e1', sequence: 10 })).toEqual({
      ok: true,
      afterSequence: 10
    })
  })

  it('forces a reload when the epoch rolled', () => {
    expect(resolveJournalResume(RANGE, { epoch: 'e0', sequence: 25 })).toEqual({
      ok: false,
      reset: 'epoch_changed'
    })
  })

  it('forces a reload when the client is ahead of the journal', () => {
    expect(resolveJournalResume(RANGE, { epoch: 'e1', sequence: 41 })).toEqual({
      ok: false,
      reset: 'cursor_ahead'
    })
  })

  it('forces a reload when the cursor fell below the compaction floor', () => {
    expect(resolveJournalResume(RANGE, { epoch: 'e1', sequence: 9 })).toEqual({
      ok: false,
      reset: 'cursor_compacted'
    })
  })
})

describe('findSequenceGap', () => {
  it('accepts a contiguous run', () => {
    expect(findSequenceGap([7, 8, 9], 7)).toBeNull()
  })

  it('reports the first missing sequence', () => {
    expect(findSequenceGap([7, 8, 10], 7)).toEqual({ gapAt: 9 })
  })

  it('reports a run that starts above the expected first sequence', () => {
    expect(findSequenceGap([8, 9], 7)).toEqual({ gapAt: 7 })
  })

  it('reports a reused sequence', () => {
    expect(findSequenceGap([7, 7, 8], 7)).toEqual({ gapAt: 8 })
  })
})
