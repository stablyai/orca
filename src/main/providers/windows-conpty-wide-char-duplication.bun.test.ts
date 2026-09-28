/** Real Windows terminal-byte fidelity for Korean wide characters and resize repaints. */
import { recordBunPtyTranscript } from './bun-pty-transcript-fixture'
import { describe, expect, it } from 'vitest'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { isWideGlyph } from '../daemon/__fixtures__/terminal-wide-cell-grid'

const itOnWindows = process.platform === 'win32' ? it : it.skip

const KOREAN_LINE = '안녕하세요 오르카 테스트입니다. 결론부터 말씀드리면 시각적 피로도'
const LATIN_LINE = 'roadmap/complete-overhaul-backlog-history.md (1.75) R-08)'
const LINE_REPEATS = 12

/** Adjacent identical wide characters. The fixtures contain none, so any hit is duplication. */
function doubledWideRuns(text: string): string[] {
  const hits: string[] = []
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!
    if (ch === text[i - 1] && isWideGlyph(ch)) {
      hits.push(`${text.slice(Math.max(0, i - 12), i + 12)}`)
    }
  }
  return hits
}

async function runThroughConpty(): Promise<string> {
  // Why node and not `echo`: cmd.exe's output codepage depends on the machine's
  // ANSI codepage, which would make the fixture bytes untrustworthy. Node always
  // writes UTF-8 here.
  const script = [
    `const ko=${JSON.stringify(KOREAN_LINE)};`,
    `const la=${JSON.stringify(LATIN_LINE)};`,
    `let i=0;`,
    `const t=setInterval(()=>{process.stdout.write(ko+"\\r\\n"+la+"\\r\\n");`,
    `if(++i>=${LINE_REPEATS}){clearInterval(t);process.exit(0);}},20);`
  ].join('')

  const events = await recordBunPtyTranscript({
    script,
    cols: 40,
    rows: 10,
    resizes: [38, 44, 36, 46].map((cols, index) => ({ cols, atMs: 60 + index * 50 }))
  })
  return events.map((event) => ('data' in event ? event.data : '')).join('')
}

// Why a self-test: the ConPTY cases only run on Windows, so without this the
// detector could rot into a vacuous pass on every other platform's CI.
describe('doubled-wide-character detector', () => {
  it('flags the text the reporter pasted into Notepad and clears the correct text', () => {
    const reported = '시시각각적적 피피로로도도 | 빨빨강강/파파랑랑/초초록록 원원색색 배배지지'
    const correct = '시각적 피로도 | 빨강/파랑/초록 원색 배지'
    expect(doubledWideRuns(reported).length).toBeGreaterThan(0)
    expect(doubledWideRuns(correct)).toEqual([])
    // Latin repeats (`ll`, `oo`) must not register, or the ConPTY cases would fail for the wrong reason.
    expect(doubledWideRuns('complete-overhaul-backlog-history.md (1.75)')).toEqual([])
  })

  it('survives the shared ANSI stripper the ConPTY cases run output through', () => {
    expect(stripAnsiEscapeSequences(`\x1b[2K${KOREAN_LINE}\x1b[0m\x1b]0;title\x07`)).toBe(
      KOREAN_LINE
    )
  })
})

describe('Windows ConPTY wide-character fidelity (#15192)', () => {
  itOnWindows(
    'does not double wide characters through the Bun ConPTY backend',
    async () => {
      const text = stripAnsiEscapeSequences(await runThroughConpty())
      // Guard against a vacuous pass: the fixture must actually have reached us.
      expect(text).toContain(KOREAN_LINE.slice(0, 5))
      expect(doubledWideRuns(text)).toEqual([])
      // Control: the Latin line survives intact, so a failure above is script-selective.
      expect(text).toContain(LATIN_LINE)
    },
    60_000
  )
})
