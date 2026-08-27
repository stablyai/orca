import { describe, expect, it } from 'vitest'
import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import { projectTerminalTailLines } from './orca-runtime'

describe('projectTerminalTailLines', () => {
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
      getBufferTailLines: () => ['old output', 'tail output'],
      getVisibleLines: () => ['────────', '❯ proceed'],
      getVisibleBufferRange: () => ({ start: 0, endExclusive: 2, totalLength: 10 }),
      getCursorLineContext: () => context
    } as unknown as HeadlessEmulator

    expect(projectTerminalTailLines(emulator, 2)).toEqual({
      lines: ['old output', 'tail output'],
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
      getBufferTailLines: () => [' with', ' release'],
      getVisibleLines: () => ['Build passed', '────────', '❯ proceed', ' with', ' release'],
      getVisibleBufferRange: () => ({ start: 0, endExclusive: 5, totalLength: 5 }),
      getCursorLineContext: () => context
    } as unknown as HeadlessEmulator

    expect(projectTerminalTailLines(emulator, 2)).toEqual({
      lines: ['────────', '❯'],
      draft: 'proceed with release'
    })
  })
})
