import { describe, expect, it } from 'vitest'
import {
  findSequenceGap,
  resolveJournalResume,
  sameJournalCursor,
  type JournalCursorRange
} from './journal-cursor'

const RANGE: JournalCursorRange = { epoch: 'e1', lastSequence: 40, oldestSequence: 11 }

describe('resolveJournalResume', () => {
  it('resumes from a cursor inside the retained tail', () => {
    expect(resolveJournalResume(RANGE, { epoch: 'e1', sequence: 25 })).toEqual({
      ok: true,
      afterSequence: 25
    })
  })

  it('resumes from a cursor sitting exactly on the compaction boundary', () => {
    expect(resolveJournalResume(RANGE, { epoch: 'e1', sequence: 10 })).toEqual({
      ok: true,
      afterSequence: 10
    })
  })

  it('resumes from a cursor at the tip with nothing to send', () => {
    expect(resolveJournalResume(RANGE, { epoch: 'e1', sequence: 40 })).toEqual({
      ok: true,
      afterSequence: 40
    })
  })

  it('forces a reload when the epoch rolled', () => {
    expect(resolveJournalResume(RANGE, { epoch: 'e0', sequence: 25 })).toEqual({
      ok: false,
      reset: 'epoch_changed'
    })
  })

  it('forces a reload when the epoch rolled even at a sequence this epoch also holds', () => {
    expect(resolveJournalResume(RANGE, { epoch: 'e0', sequence: 40 }).ok).toBe(false)
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

  it('resumes a fresh client from sequence 0 on an uncompacted journal', () => {
    const fresh: JournalCursorRange = { epoch: 'e1', lastSequence: 3, oldestSequence: 1 }
    expect(resolveJournalResume(fresh, { epoch: 'e1', sequence: 0 })).toEqual({
      ok: true,
      afterSequence: 0
    })
  })

  it('rejects sequence 0 once the journal has compacted past it', () => {
    expect(resolveJournalResume(RANGE, { epoch: 'e1', sequence: 0 })).toEqual({
      ok: false,
      reset: 'cursor_compacted'
    })
  })
})

describe('sameJournalCursor', () => {
  it('requires both the epoch and the sequence to match', () => {
    expect(sameJournalCursor({ epoch: 'e1', sequence: 3 }, { epoch: 'e1', sequence: 3 })).toBe(true)
    expect(sameJournalCursor({ epoch: 'e1', sequence: 3 }, { epoch: 'e2', sequence: 3 })).toBe(
      false
    )
    expect(sameJournalCursor({ epoch: 'e1', sequence: 3 }, { epoch: 'e1', sequence: 4 })).toBe(
      false
    )
  })
})

describe('findSequenceGap', () => {
  it('accepts a contiguous run', () => {
    expect(findSequenceGap([7, 8, 9], 7)).toBeNull()
  })

  it('accepts an empty run', () => {
    expect(findSequenceGap([], 7)).toBeNull()
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
