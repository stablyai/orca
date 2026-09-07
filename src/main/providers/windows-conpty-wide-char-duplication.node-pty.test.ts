/**
 * Real-ConPTY reproduction for #15192: wide characters arrive doubled in the
 * terminal buffer on Windows (`안녕하세요` -> `안안녕녕하하세세요요`), while
 * Latin is never affected.
 *
 * Why at this layer and not in the renderer: every renderer-side duplication
 * path (delivery replay, snapshot restore, output-queue chunking) is
 * script-blind and would double ASCII too. The one component in the stack that
 * represents a character as TWO cells is the Windows console text buffer, where
 * a DBCS glyph occupies a leading and a trailing cell that both carry the same
 * wchar. Emitting the trailing cell as text produces exactly the reported
 * signature. So the assertion is on the bytes node-pty hands us, BEFORE xterm.
 *
 * Orca pins the ConPTY implementation with `useConptyDll: true`
 * (local-pty-utils.ts, pty-subprocess.ts, windows-conpty-warmup.ts), so the
 * bundled OpenConsole build is a variable we control and the system one is the
 * A/B. Both are exercised here.
 *
 * Runs only on win32; skipped elsewhere (macOS/Linux have no ConPTY).
 */
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

  const proc = nodePty.spawn(process.execPath, ['-e', script], {
    name: 'xterm-256color',
    // Why narrow: the reporter's doubling shows on wrapped rows, and a wide glyph
    // straddling the wrap boundary is where the leading/trailing cell pair matters.
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
  // Why a resize mid-stream: ConPTY repaints its viewport on a size change, and
  // the report is intermittent in a way that tracks repaints (the reporter's own
  // workaround is resizing the window).
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
    // Why: a child that never exits would otherwise outlive the run and leak into the rest of the job.
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
    'does not double wide characters with the bundled ConPTY (useConptyDll)',
    async () => {
      const text = stripAnsiEscapeSequences(await runThroughConpty({ useConptyDll: true }))
      // Guard against a vacuous pass: the fixture must actually have reached us.
      expect(text).toContain(KOREAN_LINE.slice(0, 5))
      expect(doubledWideRuns(text)).toEqual([])
      // Control: the Latin line survives intact, so a failure above is script-selective.
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
