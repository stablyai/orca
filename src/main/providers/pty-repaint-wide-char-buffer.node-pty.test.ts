/** #15192: replay ConPTY bytes/resizes into the host emulator and assert buffer cells, since valid repaint bytes can still duplicate glyphs.
 * Fixture/control assertions also run on POSIX; only bundled-vs-system ConPTY comparison requires Windows. */
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { isWideGlyph, readWrappedLineGlyphs } from '../daemon/__fixtures__/terminal-wide-cell-grid'

const itOnWindows = process.platform === 'win32' ? it : it.skip

const KOREAN_LINE = '안녕하세요 오르카 테스트입니다. 결론부터 말씀드리면 시각적 피로도'
const LATIN_LINE = 'roadmap/complete-overhaul-backlog-history.md (1.75) R-08)'
const LINE_REPEATS = 8
const COLS = 40
const ROWS = 12

const glyphsOf = (line: string): string => line.replace(/\s+/g, '')
const KOREAN_GLYPHS = glyphsOf(KOREAN_LINE)
const LATIN_GLYPHS = glyphsOf(LATIN_LINE)

type Event = { data: string } | { resizeTo: number }

type RunOptions = {
  useConptyDll: boolean
  /** Milliseconds after spawn at which to resize, paired with the target width. */
  resizes?: { atMs: number; cols: number }[]
  /** How long the child stays alive after its last write, so a resize can trigger a repaint. */
  holdMs: number
}

// Node writes deterministic UTF-8; cmd.exe output depends on the machine codepage.
function childScript(holdMs: number): string {
  return [
    `const ko=${JSON.stringify(KOREAN_LINE)};`,
    `const la=${JSON.stringify(LATIN_LINE)};`,
    `let i=0;`,
    `const t=setInterval(()=>{process.stdout.write(ko+"\\r\\n"+la+"\\r\\n");`,
    `if(++i>=${LINE_REPEATS}){clearInterval(t);setTimeout(()=>process.exit(0),${holdMs});}},25);`
  ].join('')
}

async function recordConpty(options: RunOptions): Promise<Event[]> {
  const nodePty = await import('node-pty')
  const proc = nodePty.spawn(process.execPath, ['-e', childScript(options.holdMs)], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    ...(options.useConptyDll ? { useConptyDll: true } : {})
  })

  // Preserve resize/output order for faithful Session.resize replay.
  const events: Event[] = []
  proc.onData((chunk) => {
    events.push({ data: chunk })
  })
  const timers = (options.resizes ?? []).map((resize) =>
    setTimeout(() => {
      events.push({ resizeTo: resize.cols })
      try {
        proc.resize(resize.cols, ROWS)
      } catch {
        /* the child may already have exited */
      }
    }, resize.atMs)
  )

  await new Promise<void>((resolve) => {
    proc.onExit(() => resolve())
  })
  for (const timer of timers) {
    clearTimeout(timer)
  }
  return events
}

function replayIntoEmulator(events: Event[]): string[] {
  const emulator = new HeadlessEmulator({ cols: COLS, rows: ROWS })
  for (const event of events) {
    if ('resizeTo' in event) {
      // Session.resize sizes the emulator before the pty; keep that order.
      emulator.resize(event.resizeTo, ROWS)
    } else {
      emulator.writeSync(event.data)
    }
  }
  const terminal = (emulator as unknown as { terminal: Terminal }).terminal
  const lines = readWrappedLineGlyphs(terminal).filter((line) => line.length > 0)
  emulator.dispose()
  return lines
}

/** Adjacent identical wide glyphs. Neither fixture contains any, so a hit is duplication. */
function doubledWideRuns(text: string): string[] {
  const hits: string[] = []
  for (let index = 1; index < text.length; index += 1) {
    const glyph = text[index]!
    if (glyph === text[index - 1] && isWideGlyph(glyph)) {
      hits.push(text.slice(Math.max(0, index - 12), index + 12))
    }
  }
  return hits
}

function expectFixtureLinesOnly(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.filter((line) => line === KOREAN_GLYPHS)).toHaveLength(LINE_REPEATS)
  // Latin is the control for script-specific corruption.
  expect(lines.filter((line) => line === LATIN_GLYPHS)).toHaveLength(LINE_REPEATS)
  expect(lines.filter((line) => line !== KOREAN_GLYPHS && line !== LATIN_GLYPHS)).toEqual([])
}

describe('doubled-wide-glyph detector', () => {
  it('flags the text the reporter pasted into Notepad and clears the correct text', () => {
    expect(doubledWideRuns('시시각각적적 피피로로도도').length).toBeGreaterThan(0)
    expect(doubledWideRuns(KOREAN_LINE)).toEqual([])
    // Latin repeats (`ll`, `oo`) must not register, or the ConPTY cases would fail for the wrong reason.
    expect(doubledWideRuns(LATIN_LINE)).toEqual([])
  })
})

describe('pty repaint fidelity in the terminal buffer (#15192)', () => {
  it('leaves the buffer holding exactly the lines that were printed', async () => {
    expectFixtureLinesOnly(
      replayIntoEmulator(await recordConpty({ useConptyDll: true, holdMs: 50 }))
    )
  }, 60_000)

  itOnWindows(
    'holds the same lines on the system ConPTY (A/B for the bundled build)',
    async () => {
      expectFixtureLinesOnly(
        replayIntoEmulator(await recordConpty({ useConptyDll: false, holdMs: 50 }))
      )
    },
    60_000
  )

  it('survives the resize the reporter used as a workaround, after output settles', async () => {
    // Resize a quiet child so only ConPTY repaint can change the settled text.
    const events = await recordConpty({
      useConptyDll: true,
      holdMs: 900,
      resizes: [
        { atMs: 450, cols: 31 },
        { atMs: 650, cols: 47 }
      ]
    })
    expectFixtureLinesOnly(replayIntoEmulator(events))
  }, 60_000)

  it('does not double a wide glyph when a resize lands mid-line', async () => {
    // Mid-line resize can disagree with xterm reflow without duplicating glyphs; assert duplication only.
    const events = await recordConpty({
      useConptyDll: true,
      holdMs: 200,
      resizes: [
        { atMs: 60, cols: 33 },
        { atMs: 110, cols: 45 },
        { atMs: 160, cols: 29 }
      ]
    })
    const lines = replayIntoEmulator(events)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.flatMap(doubledWideRuns)).toEqual([])
    expect(lines).toContain(LATIN_GLYPHS)
  }, 60_000)
})
