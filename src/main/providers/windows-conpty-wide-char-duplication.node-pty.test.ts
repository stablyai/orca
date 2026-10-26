/** #15192: test bundled/system ConPTY bytes for duplicate wide glyphs before xterm replay.
 * Wide cells carry two copies of a wchar; script-blind renderer duplication would also affect Latin controls. */
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

async function runThroughConpty(opts: { useConptyDll: boolean }): Promise<string> {
  const nodePty = await import('node-pty')
  // Node writes deterministic UTF-8; cmd.exe codepage would make fixture bytes machine-dependent.
  const script = [
    `const ko=${JSON.stringify(KOREAN_LINE)};`,
    `const la=${JSON.stringify(LATIN_LINE)};`,
    `let i=0;`,
    `const t=setInterval(()=>{process.stdout.write(ko+"\\r\\n"+la+"\\r\\n");`,
    `if(++i>=${LINE_REPEATS}){clearInterval(t);process.exit(0);}},20);`
  ].join('')

  const proc = nodePty.spawn(process.execPath, ['-e', script], {
    name: 'xterm-256color',
    // Narrow rows force wide glyphs across wrap boundaries where leading/trailing cells matter.
    cols: 40,
    rows: 10,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    ...(opts.useConptyDll ? { useConptyDll: true } : {})
  })

  let out = ''
  proc.onData((chunk) => {
    out += chunk
  })
  // Resize triggers the repaint implicated by the intermittent report and its workaround.
  const resizes = [38, 44, 36, 46]
  const timers = resizes.map((cols, index) =>
    setTimeout(
      () => {
        try {
          proc.resize(cols, 10)
        } catch {
          /* the child may already have exited */
        }
      },
      60 + index * 50
    )
  )

  try {
    await new Promise<void>((resolve) => {
      proc.onExit(() => resolve())
    })
  } finally {
    // Always stop the fixture child so a hang cannot leak into later jobs.
    for (const timer of timers) {
      clearTimeout(timer)
    }
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }
  return out
}

// Run detector assertions on all hosts so Windows-only cases cannot hide a broken detector.
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
    'does not double wide characters with the bundled ConPTY (useConptyDll)',
    async () => {
      const text = stripAnsiEscapeSequences(await runThroughConpty({ useConptyDll: true }))
      expect(text).toContain(KOREAN_LINE.slice(0, 5))
      expect(doubledWideRuns(text)).toEqual([])
      // Latin is the control for script-specific corruption.
      expect(text).toContain(LATIN_LINE)
    },
    60_000
  )

  itOnWindows(
    'does not double wide characters with the system ConPTY (A/B for the bundled build)',
    async () => {
      const text = stripAnsiEscapeSequences(await runThroughConpty({ useConptyDll: false }))
      expect(doubledWideRuns(text)).toEqual([])
    },
    60_000
  )
})
