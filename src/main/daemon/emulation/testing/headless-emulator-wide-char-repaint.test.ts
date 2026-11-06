/** Assert cell placement after repaint: valid stream bytes can still overwrite half of a wide glyph. */
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from '../headless-emulator'
import { readGridRows } from '../../__fixtures__/terminal-wide-cell-grid'

const KO = '안녕하세요 오르카 테스트입니다.'
const KO2 = '결론부터 말씀드리면 시각적 피로도'
const LA = 'roadmap/complete-overhaul-backlog-history.md'
const ROWS = 14

type Painted = { rows: string[]; emulator: HeadlessEmulator }

function paint(cols: number, sequence: string): Painted {
  const emulator = new HeadlessEmulator({ cols, rows: ROWS })
  emulator.writeSync(sequence)
  const terminal = (emulator as unknown as { terminal: Terminal }).terminal
  return { rows: readGridRows(terminal, ROWS), emulator }
}

describe('repaint over wide characters (#15192)', () => {
  it('keeps a repainted buffer intact through the snapshot the renderer replays', () => {
    // Reserializing a half-addressed wide cell could duplicate it in every restored pane.
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
})
