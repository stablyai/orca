import { describe, expect, it } from 'vitest'
import { getFoldSplit } from './fold-division'

// Measured on the iPhone Duo simulator (iOS 27.1), inner display, half folded; the frames include
// the 20pt margins UIKit reserves on each side of the fold.
const INNER_LANDSCAPE = { x: 0, y: 0, width: 951, height: 669 }
const BOOK_FOLD = { x: 455.5, y: 0, width: 40, height: 669 }
const INNER_PORTRAIT = { x: 0, y: 0, width: 669, height: 951 }
const TABLETOP_FOLD = { x: 0, y: 455.5, width: 669, height: 40 }

describe('getFoldSplit', () => {
  it('splits left from right in book posture and top from bottom in tabletop posture', () => {
    expect(getFoldSplit([BOOK_FOLD], INNER_LANDSCAPE)).toEqual({
      axis: 'vertical',
      start: 455.5,
      end: 495.5,
      size: 951
    })
    expect(getFoldSplit([TABLETOP_FOLD], INNER_PORTRAIT)).toEqual({
      axis: 'horizontal',
      start: 455.5,
      end: 495.5,
      size: 951
    })
  })

  it('answers in the coordinates of a frame inset in the window', () => {
    expect(getFoldSplit([BOOK_FOLD], { x: 59, y: 0, width: 808, height: 669 })).toEqual({
      axis: 'vertical',
      start: 396.5,
      end: 436.5,
      size: 808
    })
  })

  it('ignores a fold at the edge of a Split View window, which splits nothing', () => {
    expect(getFoldSplit([BOOK_FOLD], { x: 0, y: 0, width: 469, height: 669 })).toBeNull()
    expect(getFoldSplit([BOOK_FOLD], { x: 482, y: 0, width: 469, height: 669 })).toBeNull()
  })

  it('ignores regions that do not cross the frame or carry no usable size', () => {
    expect(getFoldSplit([{ ...BOOK_FOLD, height: 300 }], INNER_LANDSCAPE)).toBeNull()
    expect(getFoldSplit([{ ...BOOK_FOLD, width: 0 }], INNER_LANDSCAPE)).toBeNull()
    expect(getFoldSplit([{ ...BOOK_FOLD, x: Number.NaN }], INNER_LANDSCAPE)).toBeNull()
    expect(getFoldSplit([BOOK_FOLD], { ...INNER_LANDSCAPE, width: 0 })).toBeNull()
    expect(getFoldSplit([], INNER_LANDSCAPE)).toBeNull()
  })
})
