import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetPtyEscapeBoundaryForTest,
  advanceEscapeBoundary,
  advancePtyEscapeBoundary,
  markPtyEscapeBoundaryUnknown,
  escapeBoundaryFields
} from './pty-escape-boundary'

afterEach(() => _resetPtyEscapeBoundaryForTest())

describe('pty escape boundary', () => {
  it('tracks an escape split across payloads', () => {
    expect(advancePtyEscapeBoundary('pty', 'a\x1b[4')).toBe('')
    expect(advancePtyEscapeBoundary('pty', '2Bb')).toBe('\x1b[')
    expect(advancePtyEscapeBoundary('pty', 'c')).toBe('')
  })

  it('stays unknown after a provider gap until an ESC, CAN or SUB resynchronizes it', () => {
    markPtyEscapeBoundaryUnknown('pty')
    expect(advancePtyEscapeBoundary('pty', '42B text')).toBeNull()
    expect(advancePtyEscapeBoundary('pty', 'x\x1b[K')).toBeNull()
    expect(advancePtyEscapeBoundary('pty', 'y')).toBe('')
    expect(advanceEscapeBoundary(null, 'osc payload\x18text')).toBe('')
  })

  it('marks every start but ground, and says when the boundary is unknown', () => {
    expect(escapeBoundaryFields('')).toEqual({})
    expect(escapeBoundaryFields(undefined)).toEqual({})
    expect(escapeBoundaryFields('\x1b[')).toEqual({ midEscape: true })
    expect(escapeBoundaryFields(null)).toEqual({ midEscape: 'unknown' })
  })

  it('treats a C1 control as an unknown boundary, since xterm parses it and the scanner does not', () => {
    // U+009B is an 8-bit CSI introducer: xterm would read `42B` after it as cursor-down.
    expect(advanceEscapeBoundary('', 'text\u009b42')).toBeNull()
    expect(advanceEscapeBoundary('', 'a\u009bb\x1b[0m')).toBe('')
  })
})
