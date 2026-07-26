import { describe, expect, it } from 'vitest'
import { findDroppedLines } from './check-no-merge-base-revert.mjs'

const base = ['const a = someValueHere', 'const b = anotherValueHere'].join('\n')
const withMainFix = [base, 'const shipped = mainAddedThisFix()'].join('\n')

describe('check-no-merge-base-revert', () => {
  it('flags a line the base branch added that the head branch lacks', () => {
    const dropped = findDroppedLines(base, withMainFix, base)
    expect(dropped).toEqual(['const shipped = mainAddedThisFix()'])
  })

  it('accepts a head branch that kept the added line', () => {
    const head = [withMainFix, 'const bound = MAX_RETAINED_BYTES'].join('\n')
    expect(findDroppedLines(base, withMainFix, head)).toEqual([])
  })

  it('is position-independent — moved code still counts as present', () => {
    const head = ['const shipped = mainAddedThisFix()', base].join('\n')
    expect(findDroppedLines(base, withMainFix, head)).toEqual([])
  })

  it('ignores whitespace and trivially short lines', () => {
    const noisy = [base, '', '   ', '//', 'x++'].join('\n')
    expect(findDroppedLines(base, noisy, base)).toEqual([])
  })

  it('flags a dropped explanatory comment', () => {
    // Losing a `// Why:` that documents a non-obvious invariant is real lost work — several of the
    // reverts this guard was written for were exactly that.
    const withComment = [base, '// Why: reused ids restart aligned at zero'].join('\n')
    expect(findDroppedLines(base, withComment, base)).toEqual([
      '// Why: reused ids restart aligned at zero'
    ])
  })

  it('reports nothing when the base branch added nothing', () => {
    expect(findDroppedLines(base, base, base)).toEqual([])
  })

  it('treats a file absent on either side as no-revert rather than throwing', () => {
    expect(findDroppedLines(null, withMainFix, base)).toEqual([])
    expect(findDroppedLines(base, null, base)).toEqual([])
  })
})
