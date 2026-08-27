/**
 * #15192, second hypothesis: the reported doubling is a REPAINT landing at the
 * wrong cells, not corrupted source bytes.
 *
 * The reporter's decisive run had the command echo doubled while that same
 * command's output was clean, so the shell never received doubled bytes; and the
 * doubled text pasted doubled into Notepad, so it was really in the buffer. A
 * stream-level assertion (windows-conpty-wide-char-duplication.node-pty.test.ts)
 * cannot see that: every byte of a bad repaint is legitimate — cursor
 * positioning plus text — and only the cells it lands on are wrong.
 *
 * So these assert BUFFER CONTENT after repaint-shaped sequences. The sharpest
 * case is a rewrite whose cursor lands on the second cell of a two-cell glyph:
 * the only place a wide character can be half-addressed, and where both
 * duplication and loss would come from. Every fixture carries a Latin control so
 * a failure proves script-selectivity rather than general corruption.
 *
 * Runs everywhere: no ConPTY needed, so this also guards macOS and Linux.
 */
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from './headless-emulator'
import { WideCellGrid, readGridRows } from './__fixtures__/terminal-wide-cell-grid'

const KO = '안녕하세요 오르카 테스트입니다.'
const KO2 = '결론부터 말씀드리면 시각적 피로도'
const LA = 'roadmap/complete-overhaul-backlog-history.md'
// Single-row fixtures: `\r` returns to the start of the last PHYSICAL row, so a
// whole-row repaint is only well defined for content that fits on one.
const KO_ROW = '안녕하세요 오르카'
const KO2_ROW = '테스트입니다.'
const LA_ROW = 'complete-overhaul.md'
const ROWS = 14

type Painted = { rows: string[]; emulator: HeadlessEmulator }

function paint(cols: number, sequence: string): Painted {
  const emulator = new HeadlessEmulator({ cols, rows: ROWS })
  emulator.writeSync(sequence)
  const terminal = (emulator as unknown as { terminal: Terminal }).terminal
  return { rows: readGridRows(terminal, ROWS), emulator }
}

function rowsOf(cols: number, sequence: string): string[] {
  const painted = paint(cols, sequence)
  painted.emulator.dispose()
  return painted.rows
}

describe('wide-character wrap fidelity', () => {
  it('places every glyph where an independent cell model does, at every width', () => {
    const mismatches: string[] = []
    for (let cols = 6; cols <= 60; cols += 1) {
      for (const text of [KO, `${LA} ${KO}`, `${KO} ${LA}`, `${KO}${KO2}`]) {
        const model = new WideCellGrid(cols)
        model.text(text)
        const actual = rowsOf(cols, text)
        if (actual.join('|') !== model.render(ROWS).join('|')) {
          mismatches.push(
            `cols=${cols} ${JSON.stringify(text.slice(0, 12))}: ${JSON.stringify(actual)}`
          )
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})

describe('repaint over wide characters (#15192)', () => {
  it('lands a rewrite correctly on every column, including a glyph trailing cell', () => {
    const mismatches: string[] = []
    for (let cols = 8; cols <= 44; cols += 1) {
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < Math.min(cols, 20); col += 1) {
          // CUP + EL + rewrite is the shape a program uses to redraw one row.
          const sequence = `${KO}\x1b[${row + 1};${col + 1}H\x1b[0K${KO2}`
          const model = new WideCellGrid(cols)
          model.text(KO)
          model.moveTo(row, col)
          model.eraseToLineEnd()
          model.text(KO2)
          const actual = rowsOf(cols, sequence)
          if (actual.join('|') !== model.render(ROWS).join('|')) {
            mismatches.push(`cols=${cols} row=${row} col=${col}: ${JSON.stringify(actual)}`)
          }
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('leaves a full-row repaint indistinguishable from writing the row once', () => {
    // ConPTY redraws by re-emitting whole rows; a row re-emitted over wide
    // characters must not differ from the same row drawn from scratch.
    const mismatches: string[] = []
    for (let cols = 22; cols <= 60; cols += 1) {
      for (const [prior, next] of [
        [KO_ROW, KO2_ROW],
        [KO2_ROW, KO_ROW],
        [LA_ROW, KO_ROW],
        [KO_ROW, LA_ROW],
        [KO_ROW, KO_ROW]
      ] as const) {
        for (const repaint of ['\r\x1b[2K', '\r\x1b[0K', '\x1b[1;1H\x1b[0K']) {
          const painted = rowsOf(cols, `${prior}${repaint}${next}`)
          const direct = rowsOf(cols, next)
          if (painted.join('|') !== direct.join('|')) {
            mismatches.push(
              `cols=${cols} ${JSON.stringify(repaint)}: painted=${JSON.stringify(painted)} direct=${JSON.stringify(direct)}`
            )
          }
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('keeps a repainted buffer intact through the snapshot the renderer replays', () => {
    // The main-side snapshot is where a half-addressed cell could be re-serialized
    // as a whole glyph, doubling it for every client that restores the pane.
    const mismatches: string[] = []
    for (let cols = 10; cols <= 44; cols += 1) {
      for (const col of [1, 2, 5, 6, 9, 10]) {
        const painted = paint(cols, `${LA}\r\n${KO}\x1b[${col}G\x1b[0K${KO2}\r\n`)
        const snapshot = painted.emulator.getSnapshot({ scrollbackRows: 400 })
        painted.emulator.dispose()
        const replay = paint(cols, `${snapshot.scrollbackAnsi ?? ''}${snapshot.snapshotAnsi}`)
        replay.emulator.dispose()
        if (replay.rows.join('|') !== painted.rows.join('|')) {
          mismatches.push(
            `cols=${cols} col=${col}: live=${JSON.stringify(painted.rows.filter(Boolean))} replay=${JSON.stringify(replay.rows.filter(Boolean))}`
          )
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('reflows to exactly what the target width would have drawn from scratch', () => {
    // The reporter's workaround was resizing the window, so the reflow path is
    // load-bearing: after it the buffer must hold what that width always shows.
    const mismatches: string[] = []
    const written = `${LA}\r\n${KO}\r\n${KO2}\r\n${LA}\r\n`
    for (let cols = 12; cols <= 48; cols += 1) {
      for (const target of [cols - 5, cols - 1, cols + 1, cols + 7]) {
        if (target < 8) {
          continue
        }
        const emulator = new HeadlessEmulator({ cols, rows: ROWS })
        emulator.writeSync(written)
        emulator.resize(target, ROWS)
        const terminal = (emulator as unknown as { terminal: Terminal }).terminal
        const reflowed = readGridRows(terminal, ROWS)
        emulator.dispose()
        const direct = rowsOf(target, written)
        if (reflowed.join('|') !== direct.join('|')) {
          mismatches.push(
            `${cols}->${target}: reflowed=${JSON.stringify(reflowed.filter(Boolean))} direct=${JSON.stringify(direct.filter(Boolean))}`
          )
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})
