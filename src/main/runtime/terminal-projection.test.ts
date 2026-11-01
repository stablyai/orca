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
  it.each([
    {
      fixture: 'claude-2-1-316-labelled-wrapped',
      cols: 40,
      draft:
        'Refactor the login page so that it\npreserves the existing\nauthentication behavior and includes\nthe coverage report'
    },
    {
      fixture: 'claude-2-1-316-default-unlabelled-middle',
      cols: 100,
      draft:
        'Refactor the login page so that it preserves the existing authentication behavior and includes\nthe coverage report'
    }
  ])(
    'separates recorded Claude draft $fixture from both screen and tail output',
    async ({ fixture, cols, draft }) => {
      const emulator = new HeadlessEmulator({ cols, rows: 30 })
      try {
        await emulator.write(readRuntimeFixture(fixture))
        for (const projection of [
          projectTerminalVisibleLines(emulator),
          projectTerminalTailLines(emulator, 30)
        ]) {
          expect(projection.draft).toBe(draft)
          expect(projection.lines).toContain('❯')
          expect(projection.lines.join('\n')).not.toContain('Refactor the login page')
          expect(projection.lines.join('\n')).not.toContain('coverage report')
        }
      } finally {
        emulator.dispose()
      }
    }
  )

  it.each([
    {
      fixture: 'claude-2-1-316-default-labelled-blurred',
      cols: 100,
      rows: 30,
      length: undefined,
      activeBuffer: 'normal',
      draft: 'Refactor the login page so that it'
    },
    {
      // Claude's alternate-screen redraw: a complete box, hidden cursor and no caret paint.
      fixture: 'claude-interrupt-tool-cancel-supported',
      cols: 120,
      rows: 40,
      length: 1321,
      activeBuffer: 'alternate',
      draft: undefined
    }
  ])(
    'keeps the active screen of $fixture through a provider snapshot replay',
    async ({ fixture, cols, rows, length, activeBuffer, draft }) => {
      const source = new HeadlessEmulator({ cols, rows })
      const replay = new HeadlessEmulator({ cols, rows })
      try {
        await source.write(readRuntimeFixture(fixture).slice(0, length))
        const snapshot = source.getSnapshot()
        // Same payload provider snapshots carry and provider-buffer-capture replays.
        await replay.write(
          `${snapshot.scrollbackAnsi}${snapshot.rehydrateSequences}${snapshot.snapshotAnsi}`
        )
        expect(replay.getCursorLineContext()).toMatchObject({ cursorHidden: true, activeBuffer })
        expect(projectTerminalTailLines(replay, rows).draft).toBe(draft)
      } finally {
        source.dispose()
        replay.dispose()
      }
    }
  )

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
