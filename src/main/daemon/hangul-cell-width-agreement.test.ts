/**
 * #15192, activation-order hypothesis: "the Orca unicode provider is not reached
 * in production, so Hangul lays out at the wrong width."
 *
 * These pin the measurements that close it. Every precomposed Hangul syllable is
 * two cells under xterm's Unicode 6 tables, its Unicode 11 tables, and Orca's
 * provider alike, so no activation order — provider, v11 fallback, or the
 * untouched v6 default — can change how a syllable is budgeted. Whatever moves
 * Korean text off its cells is not the unicode version.
 *
 * The version-sensitive and oracle-sensitive code points are pinned too, as the
 * complete list of Hangul-block characters where a width disagreement is even
 * available. None of them occur in modern Korean prose.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { activateOrcaTerminalUnicodeProvider } from '../../shared/terminal-unicode-provider'
import { isWideGlyph } from './__fixtures__/terminal-wide-cell-grid'

const ORCA_UNICODE_VERSION = 'orca-11-zwj'
const HANGUL_SYLLABLES_FIRST = 0xac00
const HANGUL_SYLLABLES_LAST = 0xd7a3

/** Jamo, Compatibility Jamo, Jamo Extended-A, Syllables + Extended-B, halfwidth jamo. */
const HANGUL_BLOCKS: [number, number][] = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
  [0xffa0, 0xffdc]
]

function* hangulCodePoints(): Generator<number> {
  for (const [first, last] of HANGUL_BLOCKS) {
    for (let cp = first; cp <= last; cp += 1) {
      yield cp
    }
  }
}

type UnicodeServiceInternals = {
  versions: string[]
  activeVersion: string
  wcwidth(codepoint: number): number
  charProperties(codepoint: number, preceding: number): number
}

/**
 * Addon first, activation after — the order every call site uses. This mirrors that
 * order rather than importing it, so it does not guard the call sites themselves;
 * `pane-lifecycle.test.ts` covers that the activation runs and runs after the addon.
 * What is unguarded, and what these cover, is that the real `_core.unicodeService`
 * shape still lets the activation reach its non-fallback branch on a live terminal.
 */
function openWithUnicode11AddonLoaded(): {
  terminal: Terminal
  unicode: UnicodeServiceInternals
} {
  const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(terminal as never)
  const unicode = (
    terminal as unknown as {
      _core: { unicodeService: UnicodeServiceInternals }
    }
  )._core.unicodeService
  return { terminal, unicode }
}

/** Width bits of xterm's packed char properties — what the buffer actually budgets. */
function propertyWidth(properties: number): number {
  return (properties >> 1) & 3
}

/**
 * Contiguous code points carrying the same detail collapse into one line. The detail
 * is part of the run key so a changed width re-partitions the output instead of
 * silently reusing a range that only ever asserted "these two disagree somehow".
 */
function summarize(entries: { codepoint: number; detail: string }[]): string[] {
  const runs: { start: number; end: number; detail: string }[] = []
  for (const { codepoint, detail } of entries) {
    const last = runs.at(-1)
    if (last && last.end === codepoint - 1 && last.detail === detail) {
      last.end = codepoint
      continue
    }
    runs.push({ start: codepoint, end: codepoint, detail })
  }
  const hex = (value: number): string => `U+${value.toString(16).toUpperCase().padStart(4, '0')}`
  return runs.map(
    ({ start, end, detail }) =>
      `${start === end ? hex(start) : `${hex(start)}..${hex(end)}`} ${detail}`
  )
}

describe('Hangul cell width agreement (#15192)', () => {
  it('reaches the Orca provider, not the v11 fallback, on a live terminal', () => {
    const { terminal, unicode } = openWithUnicode11AddonLoaded()
    expect(unicode.versions).toContain(ORCA_UNICODE_VERSION)
    expect(unicode.activeVersion).toBe(ORCA_UNICODE_VERSION)
    terminal.dispose()
  })

  it('budgets every precomposed syllable at two cells under v6, v11 and Orca', () => {
    const { terminal, unicode } = openWithUnicode11AddonLoaded()
    const disagreeing: { codepoint: number; detail: string }[] = []
    for (const version of ['6', '11', ORCA_UNICODE_VERSION]) {
      unicode.activeVersion = version
      for (let cp = HANGUL_SYLLABLES_FIRST; cp <= HANGUL_SYLLABLES_LAST; cp += 1) {
        const wcwidth = unicode.wcwidth(cp)
        const packed = propertyWidth(unicode.charProperties(cp, 0))
        if (wcwidth !== 2 || packed !== 2) {
          disagreeing.push({
            codepoint: cp,
            detail: `v${version} wcwidth=${wcwidth} packed=${packed}`
          })
        }
      }
    }
    expect(summarize(disagreeing)).toEqual([])
    terminal.dispose()
  })

  it('records where the wide-cell oracle diverges from xterm on conjoining jamo', () => {
    const { terminal, unicode } = openWithUnicode11AddonLoaded()
    const divergent: { codepoint: number; detail: string }[] = []
    for (const cp of hangulCodePoints()) {
      const oracle = isWideGlyph(String.fromCodePoint(cp)) ? 2 : 1
      const xterm = unicode.wcwidth(cp)
      if (xterm !== oracle) {
        divergent.push({ codepoint: cp, detail: `oracle=${oracle} xterm=${xterm}` })
      }
    }
    // Why pinned rather than fixed: xterm treats medial/final jamo as zero-width
    // combining marks, the oracle as one cell — and `isWideGlyph` returns a boolean,
    // so it cannot express zero-width without changing shape. Only decomposed (NFD)
    // Korean reaches them and no fixture writes NFD today, so nothing mis-asserts;
    // this is the tripwire for the fixture that adds it. U+3130/U+318F are unassigned
    // Compatibility Jamo edges. U+A960..U+A97C is assigned Jamo Extended-A (Old Korean
    // initials) that xterm makes wide and the oracle narrow — the dangerous direction,
    // but no fixture uses it. Both widths are asserted so changing either trips this.
    expect(summarize(divergent)).toEqual([
      'U+1160..U+11FF oracle=1 xterm=0',
      'U+3130 oracle=2 xterm=1',
      'U+318F oracle=2 xterm=1',
      'U+A960..U+A97C oracle=1 xterm=2'
    ])
    terminal.dispose()
  })
})
