import { applyPatch, createPatch } from 'diff'
import { describe, expect, it } from 'vitest'
import { boundedPatch } from './provider-timeline-bounded-patch'

const numbered = (count: number, eol = '\n'): string =>
  Array.from({ length: count }, (_, index) => `line ${index}\t${'x'.repeat(40)}${eol}`).join('')
const fullPatch = (before: string, after: string): string | undefined =>
  createPatch('notes.txt', before, after, undefined, undefined, { maxEditLength: 1024 })

describe('boundedPatch', () => {
  it('diffs only the changed lines of a large file', () => {
    const large = numbered(4000)
    const crlf = numbered(4000, '\r\n')
    const unicode = Array.from({ length: 20000 }, (_, index) => `한글 ${index} 🎉\n`).join('')
    const cases: [string, string][] = [
      [large, large.replace('line 2000\t', 'line 2000 edited\t')],
      [
        large,
        large.replace('line 1990\t', 'line 1990 x\t').replace('line 2010\t', 'line 2010 x\t')
      ],
      [large, `${large}appended`],
      [large, large.replace('line 0\t', 'first\t')],
      [crlf, crlf.replace('line 1000\t', 'line 1000 edited\t')],
      [unicode, unicode.replace('한글 15000 🎉', '한글 15000 🎊')],
      [`${large}tail`, `${large}tail\n`]
    ]
    for (const [before, after] of cases) {
      expect(boundedPatch('notes.txt', before, after)).toBe(fullPatch(before, after))
    }
  })

  it('matches the full diff of repeated blocks in a large file', () => {
    const lines = ['for (const item of items) {']
    for (const name of ['a', 'b', 'c']) {
      lines.push(`  if (!item.${name}) {`, '    continue', '  }')
    }
    lines.push('  use(item)', '}', '')
    const large = numbered(4000)
    const before = large + lines.join('\n') + large
    for (let at = 0; at < lines.length; at++) {
      for (let count = 1; count <= 6; count++) {
        const after = large + [...lines.slice(0, at + count), ...lines.slice(at)].join('\n') + large
        expect(boundedPatch('notes.txt', before, after)).toBe(fullPatch(before, after))
      }
    }
  })

  it('falls back to a replacement of only the changed lines when the span is too large to diff', () => {
    const before = numbered(8000)
    const cases: [string, string][] = [
      [
        before.replace('line 1\t', 'line 1 edited\t').replace('line 7998\t', 'end\t'),
        '-2,7998 +2,7998'
      ],
      [before.replace(/^(line [2-3]\d{3})\t/gm, '$1 rewritten\t'), '-2001,2000 +2001,2000'],
      [before.replace(/^(line 4[0-1]\d{2})\t/gm, '$1 rewritten\t'), '-4001,200 +4001,200'],
      [before.replace(/^line 4000\t/m, `${'added\n'.repeat(300)}$&`), '-4000,0 +4001,300'],
      [before.replace(/^line 4[0-2]\d{2}\t.*\n/gm, ''), '-4001,300 +4000,0']
    ]
    for (const [after, range] of cases) {
      const patch = boundedPatch('notes.txt', before, after)
      expect(patch.split('\n')[2]).toBe(`@@ ${range} @@`)
      expect(applyPatch(before, patch)).toBe(after)
    }
  })
})
