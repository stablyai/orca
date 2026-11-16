import { describe, expect, it } from 'vitest'
import type { MobileDiffLine } from './mobile-diff-lines'
import { buildMobileDiffReviewRows } from './mobile-diff-review-rows'

function contextLines(...texts: string[]): MobileDiffLine[] {
  return texts.map((text) => ({ kind: 'context', text }))
}

describe('buildMobileDiffReviewRows', () => {
  it('uses the nearest enclosing scope and returns to the function after an if block', () => {
    const rows = buildMobileDiffReviewRows(
      [
        { kind: 'add', text: 'function run() {' },
        ...contextLines(
          '\tif (ready) {',
          '\t    first()',
          '\t    second()',
          '\t    third()',
          '\t    fourth()',
          '\t    fifth()',
          '        sixth()',
          '        seventh()',
          '        eighth()'
        ),
        { kind: 'add', text: '        changed()' },
        ...contextLines(
          '\t}',
          '    afterOne()',
          '    afterTwo()',
          '    afterThree()',
          '    afterFour()',
          '    afterFive()',
          '    afterSix()',
          '    afterSeven()',
          '    afterEight()'
        ),
        { kind: 'add', text: '    changedAgain()' },
        ...contextLines('}')
      ],
      new Set()
    )

    expect(rows.filter((row) => row.kind === 'fold').map((row) => row.enclosingLine)).toEqual([
      'if (ready) {',
      'function run() {'
    ])
  })

  it('leaves the scope empty when a fold reaches EOF without a visible tail', () => {
    const rows = buildMobileDiffReviewRows(
      [
        { kind: 'add', text: 'function run() {' },
        ...contextLines('  first()', '  second()', '  third()', '  fourth()', '  fifth()', '}')
      ],
      new Set()
    )

    expect(rows.at(-1)).toMatchObject({ kind: 'fold', enclosingLine: null })
  })

  it('skips blank and deleted lines when finding the visible tail and its scope', () => {
    const rows = buildMobileDiffReviewRows(
      [
        ...contextLines(
          'function run() {',
          '  if (ready) {',
          '    first()',
          '    second()',
          '    third()',
          '    fourth()',
          '',
          '  ',
          ''
        ),
        { kind: 'delete', text: '}' },
        { kind: 'delete', text: '  if (removed) {' },
        ...contextLines('', '\t', '    tail()'),
        { kind: 'add', text: '    changed()' },
        ...contextLines('  }', '}')
      ],
      new Set()
    )

    expect(rows.filter((row) => row.kind === 'fold').map((row) => row.enclosingLine)).toEqual([
      'if (ready) {'
    ])
  })
})
