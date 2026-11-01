import { describe, expect, it } from 'vitest'
import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'
import {
  projectTerminalTailLines,
  projectTerminalVisibleLines
} from './orca-runtime-terminal-projection'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'

function rowsOf(lines: string[]) {
  return lines.map((text) => ({ text, metadata: { wrapped: false, trailingSpaces: 0 } }))
}

describe('projectTerminalTailLines', () => {
  it('separates a recorded labelled Claude draft from both screen and tail output', async () => {
    const emulator = new HeadlessEmulator({ cols: 40, rows: 30 })
    try {
      await emulator.write(readRuntimeFixture('claude-2-1-316-labelled-wrapped'))
      for (const projection of [
        projectTerminalVisibleLines(emulator),
        projectTerminalTailLines(emulator, 30)
      ]) {
        expect(projection.draft).toBe(
          'Refactor the login page so that it\npreserves the existing\nauthentication behavior and includes\nthe coverage report'
        )
        expect(projection.lines).toContain('❯')
        expect(projection.lines.join('\n')).not.toContain('Refactor the login page')
        expect(projection.lines.join('\n')).not.toContain('coverage report')
      }
    } finally {
      emulator.dispose()
    }
  })

  it('does not splice a scrolled viewport into unrelated tail rows', () => {
    const context: TerminalCursorContext = {
      rows: ['────────', '❯ proceed'],
      typedRows: ['────────', '❯'],
      promptGlyphBoldRows: [false, false],
      rowsBelow: [],
      typedRowsBelow: [],
      beforeCursor: '❯ ',
      afterCursor: '',
      rawAfterCursor: 'proceed',
      cursorHidden: false,
      cursorViewportRow: 1
    }
    const emulator = {
      getBufferTailRows: () => rowsOf(['old output', 'tail output']),
      getVisibleRows: () => rowsOf(['────────', '❯ proceed']),
      getVisibleBufferRange: () => ({ start: 0, endExclusive: 2, totalLength: 10 }),
      getCursorLineContext: () => context
    }

    expect(projectTerminalTailLines(emulator, 2)).toEqual({
      lines: ['old output', 'tail output'],
      tailRows: rowsOf(['old output', 'tail output']).map((row) => row.metadata),
      draft: 'proceed'
    })
  })

  it('backfills the prompt row when a small limit contains only draft continuations', () => {
    const context: TerminalCursorContext = {
      rows: ['────────', '❯ proceed'],
      typedRows: ['────────', '❯'],
      promptGlyphBoldRows: [false, false],
      rowsBelow: [' with', ' release'],
      typedRowsBelow: ['', ''],
      rowsBelowWrapped: [true, true],
      beforeCursor: '❯ ',
      afterCursor: '',
      rawAfterCursor: 'proceed',
      cursorHidden: false,
      cursorViewportRow: 2
    }
    const emulator = {
      getBufferTailRows: () => rowsOf([' with', ' release']),
      getVisibleRows: () => rowsOf(['Build passed', '────────', '❯ proceed', ' with', ' release']),
      getVisibleBufferRange: () => ({ start: 0, endExclusive: 5, totalLength: 5 }),
      getCursorLineContext: () => context
    }

    expect(projectTerminalTailLines(emulator, 2)).toEqual({
      lines: ['────────', '❯'],
      tailRows: rowsOf(['────────', '❯']).map((row) => row.metadata),
      draft: 'proceed with release'
    })
  })
})
