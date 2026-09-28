/** Replays real Bun terminal output into Orca's emulator to check wide-cell fidelity. */
import { recordBunPtyTranscript, type PtyTranscriptEvent } from './bun-pty-transcript-fixture'
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { isWideGlyph, readWrappedLineGlyphs } from '../daemon/__fixtures__/terminal-wide-cell-grid'

const KOREAN_LINE = '안녕하세요 오르카 테스트입니다. 결론부터 말씀드리면 시각적 피로도'
const LATIN_LINE = 'roadmap/complete-overhaul-backlog-history.md (1.75) R-08)'
const LINE_REPEATS = 8
const COLS = 40
const ROWS = 12

const glyphsOf = (line: string): string => line.replace(/\s+/g, '')
const KOREAN_GLYPHS = glyphsOf(KOREAN_LINE)
const LATIN_GLYPHS = glyphsOf(LATIN_LINE)

type Event = PtyTranscriptEvent

type RunOptions = {
  /** Milliseconds after spawn at which to resize, paired with the target width. */
  resizes?: { atMs: number; cols: number }[]
  /** How long the child stays alive after its last write, so a resize can trigger a repaint. */
  holdMs: number
}

/** Why node and not a shell: cmd.exe's output codepage follows the machine's ANSI codepage, so the fixture bytes would not be trustworthy. */
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
  return recordBunPtyTranscript({
    script: childScript(options.holdMs),
    cols: COLS,
    rows: ROWS,
    resizes: options.resizes
  })
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
  // Guard against a vacuous pass: the fixture must actually have reached us.
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.filter((line) => line === KOREAN_GLYPHS)).toHaveLength(LINE_REPEATS)
  // Control: Latin survives whatever happened above, so a failure is script-selective.
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
    expectFixtureLinesOnly(replayIntoEmulator(await recordConpty({ holdMs: 50 })))
  }, 60_000)

  it('survives the resize the reporter used as a workaround, after output settles', async () => {
    // Resizing once the child is quiet isolates the repaint: nothing is being
    // written, so any line that changes was moved by ConPTY's redraw alone.
    const events = await recordConpty({
      holdMs: 900,
      resizes: [
        { atMs: 450, cols: 31 },
        { atMs: 650, cols: 47 }
      ]
    })
    expectFixtureLinesOnly(replayIntoEmulator(events))
  }, 60_000)

  it('does not double a wide glyph when a resize lands mid-line', async () => {
    // Deliberately weaker than the cases above: a resize that interrupts a line
    // lets ConPTY's reflow and xterm's disagree about where the tail belongs,
    // which would fail an exact comparison without proving duplication. What
    // must never happen either way is a glyph appearing twice.
    const events = await recordConpty({
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
