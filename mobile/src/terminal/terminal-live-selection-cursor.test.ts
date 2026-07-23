import { describe, expect, it } from 'vitest'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'
import {
  clampUtf16OffsetToCodePointBoundary,
  codePointIndexToUtf16Offset,
  nativeSelectionToNormalizedCodePointIndex,
  planTerminalLiveFieldTextChange,
  planTerminalLiveSelectionMove,
  utf16OffsetToCodePointIndex,
  type TerminalLiveSelectionCursorState
} from './terminal-live-selection-cursor'

const identity = (text: string): string => text

function state(
  partial: Partial<TerminalLiveSelectionCursorState>
): TerminalLiveSelectionCursorState {
  return {
    sentText: '',
    heldText: '',
    ptyCursorCodePoint: 0,
    fieldText: '',
    ...partial
  }
}

describe('terminal live selection cursor indexing', () => {
  it('Given emoji When mapping UTF-16 offsets Then does not split surrogate pairs', () => {
    const text = 'a👍b'
    // a=1 unit, 👍=2 units, b=1 unit → length 4
    expect(text.length).toBe(4)
    expect(clampUtf16OffsetToCodePointBoundary(text, 2)).toBe(1)
    expect(utf16OffsetToCodePointIndex(text, 0)).toBe(0)
    expect(utf16OffsetToCodePointIndex(text, 1)).toBe(1)
    expect(utf16OffsetToCodePointIndex(text, 2)).toBe(1)
    expect(utf16OffsetToCodePointIndex(text, 3)).toBe(2)
    expect(utf16OffsetToCodePointIndex(text, 4)).toBe(3)
    expect(codePointIndexToUtf16Offset(text, 2)).toBe(3)
  })

  it('Given CJK When mapping offsets Then one code point per character', () => {
    const text = '你a好'
    expect(utf16OffsetToCodePointIndex(text, 1)).toBe(1)
    expect(utf16OffsetToCodePointIndex(text, 2)).toBe(2)
    expect(utf16OffsetToCodePointIndex(text, 3)).toBe(3)
  })

  it('Given smart-dash field text When mapping selection Then expands through normalization', () => {
    const raw = 'a–b'
    expect(nativeSelectionToNormalizedCodePointIndex(raw, 2, normalizeTerminalTextInput)).toBe(3)
    expect(nativeSelectionToNormalizedCodePointIndex(raw, 1, normalizeTerminalTextInput)).toBe(1)
  })
})

describe('terminal live selection move plans', () => {
  it('Given caret at end When moved to middle Then emits ordered ArrowLeft bytes', () => {
    const plan = planTerminalLiveSelectionMove(
      state({ sentText: 'abcdef', fieldText: 'abcdef', ptyCursorCodePoint: 6 }),
      { start: 3, end: 3 },
      { normalize: identity, rawFieldText: 'abcdef' }
    )

    expect(plan).not.toBeNull()
    expect(plan?.payload).toBe('\x1b[D'.repeat(3))
    expect(plan?.nextPtyCursorCodePoint).toBe(3)
  })

  it('Given repeated selection at the same collapsed index Then emits nothing', () => {
    const plan = planTerminalLiveSelectionMove(
      state({ sentText: 'abc', fieldText: 'abc', ptyCursorCodePoint: 1 }),
      { start: 1, end: 1 },
      { normalize: identity, rawFieldText: 'abc' }
    )

    expect(plan).toBeNull()
  })

  it('Given caret in the middle When moved right Then emits ordered ArrowRight bytes', () => {
    const plan = planTerminalLiveSelectionMove(
      state({ sentText: 'abcdef', fieldText: 'abcdef', ptyCursorCodePoint: 2 }),
      { start: 5, end: 5 },
      { normalize: identity, rawFieldText: 'abcdef' }
    )

    expect(plan).not.toBeNull()
    expect(plan?.payload).toBe('\x1b[C'.repeat(3))
    expect(plan?.nextPtyCursorCodePoint).toBe(5)
  })

  it('Given a non-collapsed range Then emits no PTY bytes', () => {
    const plan = planTerminalLiveSelectionMove(
      state({ sentText: 'abcdef', fieldText: 'abcdef', ptyCursorCodePoint: 6 }),
      { start: 1, end: 4 },
      { normalize: identity, rawFieldText: 'abcdef' }
    )

    expect(plan).toBeNull()
  })

  it('Given held Hangul When selection moves left Then flushes the syllable before arrows', () => {
    const plan = planTerminalLiveSelectionMove(
      state({
        sentText: '한',
        heldText: '글',
        fieldText: '한글',
        ptyCursorCodePoint: 1
      }),
      { start: 1, end: 1 },
      { normalize: identity, rawFieldText: '한글' }
    )

    expect(plan).not.toBeNull()
    expect(plan?.payload).toBe('글' + '\x1b[D')
    expect(plan?.nextSentText).toBe('한글')
    expect(plan?.heldText).toBe('')
    expect(plan?.nextPtyCursorCodePoint).toBe(1)
  })

  it('Given emoji field When caret crosses the emoji Then counts one code point', () => {
    const text = 'a👍b'
    const plan = planTerminalLiveSelectionMove(
      state({ sentText: text, fieldText: text, ptyCursorCodePoint: 3 }),
      { start: 1, end: 1 },
      { normalize: identity, rawFieldText: text }
    )

    expect(plan?.payload).toBe('\x1b[D'.repeat(2))
    expect(plan?.nextPtyCursorCodePoint).toBe(1)
  })
})

describe('terminal live field text change plans', () => {
  it('Given middle insertion Then yields abcXdef with caret after X in one payload', () => {
    const plan = planTerminalLiveFieldTextChange(
      state({ sentText: 'abcdef', fieldText: 'abcdef', ptyCursorCodePoint: 3 }),
      'abcXdef',
      { start: 4, end: 4 },
      { normalize: identity, commitHeld: false }
    )

    expect(plan.payload).toBe('\x1b[C'.repeat(3) + '\x7f'.repeat(3) + 'Xdef' + '\x1b[D'.repeat(3))
    expect(plan.nextSentText).toBe('abcXdef')
    expect(plan.nextPtyCursorCodePoint).toBe(4)
    expect(plan.heldText).toBe('')
  })

  it('Given middle deletion Then restores, erases, and reseats the caret', () => {
    // "abXcd" with caret after X (3) → delete X → "abcd" caret at 2
    const plan = planTerminalLiveFieldTextChange(
      state({ sentText: 'abXcd', fieldText: 'abXcd', ptyCursorCodePoint: 3 }),
      'abcd',
      { start: 2, end: 2 },
      { normalize: identity, commitHeld: false }
    )

    expect(plan.payload).toBe('\x1b[C'.repeat(2) + '\x7f'.repeat(3) + 'cd' + '\x1b[D'.repeat(2))
    expect(plan.nextSentText).toBe('abcd')
    expect(plan.nextPtyCursorCodePoint).toBe(2)
  })

  it('Given end typing Then emits only the appended suffix with no arrows', () => {
    const plan = planTerminalLiveFieldTextChange(
      state({ sentText: 'ab', fieldText: 'ab', ptyCursorCodePoint: 2 }),
      'abc',
      { start: 3, end: 3 },
      { normalize: identity, commitHeld: false }
    )

    expect(plan.payload).toBe('c')
    expect(plan.nextSentText).toBe('abc')
    expect(plan.nextPtyCursorCodePoint).toBe(3)
  })

  it('Given Hangul composition at end Then still holds the trailing syllable', () => {
    const plan = planTerminalLiveFieldTextChange(
      state({ sentText: '', fieldText: '', ptyCursorCodePoint: 0 }),
      '한',
      { start: 1, end: 1 },
      { normalize: identity, commitHeld: false }
    )

    expect(plan.payload).toBe('')
    expect(plan.nextSentText).toBe('')
    expect(plan.heldText).toBe('한')
    expect(plan.nextPtyCursorCodePoint).toBe(0)
  })

  it('Given dictation rewrite When selection unknown Then converges text and infers caret after the edit span', () => {
    const plan = planTerminalLiveFieldTextChange(
      state({ sentText: 'high', fieldText: 'high', ptyCursorCodePoint: 4 }),
      'hi there',
      null,
      { normalize: identity, commitHeld: false }
    )

    // common prefix "hi", no common suffix → caret at end of "hi there"
    expect(plan.payload).toBe('\x7f\x7f there')
    expect(plan.nextSentText).toBe('hi there')
    expect(plan.nextPtyCursorCodePoint).toBe(8)
  })

  it('Given middle insertion without selection Then still reseats after the inserted character', () => {
    const plan = planTerminalLiveFieldTextChange(
      state({ sentText: 'abcdef', fieldText: 'abcdef', ptyCursorCodePoint: 3 }),
      'abcXdef',
      null,
      { normalize: identity, commitHeld: false }
    )

    expect(plan.payload).toBe('\x1b[C'.repeat(3) + '\x7f'.repeat(3) + 'Xdef' + '\x1b[D'.repeat(3))
    expect(plan.nextPtyCursorCodePoint).toBe(4)
  })
})
