import { describe, expect, it } from 'vitest'
import type { HeadlessEmulator } from '../../daemon/headless-emulator'
import { projectTerminalVisibleLines } from '../orca-runtime-terminal-projection'

describe('canvas delivery composer readiness', () => {
  it.each([
    { text: '', hidden: false, frame: '────────', ready: true },
    { text: 'unfinished user request', hidden: false, frame: '────────', ready: false },
    { text: '', hidden: true, frame: '────────', ready: false },
    { text: '', hidden: false, frame: 'ordinary shell', ready: false }
  ])('requires a recognized empty composer: %j', ({ text, hidden, frame, ready }) => {
    const emulator = {
      getVisibleLines: () => [frame, `❯ ${text}`],
      getCursorLineContext: () => ({
        rows: [frame, `❯ ${text}`],
        typedRows: [frame, `❯ ${text}`],
        promptGlyphBoldRows: [false, false],
        rowsBelow: [],
        typedRowsBelow: [],
        beforeCursor: `❯ ${text}`,
        afterCursor: '',
        rawAfterCursor: '',
        cursorHidden: hidden,
        cursorViewportRow: 1
      })
    } as unknown as HeadlessEmulator
    expect(projectTerminalVisibleLines(emulator).composerReady).toBe(ready)
  })
})
