import { describe, expect, it } from 'vitest'
import {
  POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY,
  SNAPSHOT_REPLAY_PREAMBLE_ALT,
  SNAPSHOT_REPLAY_PREAMBLE_NORMAL,
  buildParityMainBufferSnapshot,
  createRendererParityTerminal,
  cursorPosition,
  normalBufferRowsTrimmed,
  normalBufferStylesTrimmed,
  visibleRowStyles,
  visibleRowWraps,
  visibleRows,
  writeChunksToTerminal
} from '../../shared/terminal-restore-parity-fixture'

type ParityTerminal = ReturnType<typeof createRendererParityTerminal>

async function restoreSerializedTerminal(source: ParityTerminal): Promise<ParityTerminal> {
  const snapshot = buildParityMainBufferSnapshot(source, 1, { scrollbackRows: 5000 })
  const restored = createRendererParityTerminal({ cols: snapshot.cols, rows: snapshot.rows })
  const preamble =
    snapshot.alternateScreen && snapshot.scrollbackAnsi !== undefined
      ? `\x1b[?1049l\x1b[2J\x1b[3J\x1b[H${snapshot.scrollbackAnsi}${SNAPSHOT_REPLAY_PREAMBLE_ALT}`
      : snapshot.alternateScreen
        ? SNAPSHOT_REPLAY_PREAMBLE_ALT
        : SNAPSHOT_REPLAY_PREAMBLE_NORMAL
  await writeChunksToTerminal(restored.terminal, [
    preamble,
    snapshot.data,
    POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY
  ])
  return restored
}

function expectActiveBufferParity(source: ParityTerminal, restored: ParityTerminal): void {
  expect(visibleRows(restored.terminal)).toEqual(visibleRows(source.terminal))
  expect(visibleRowStyles(restored.terminal)).toEqual(visibleRowStyles(source.terminal))
  expect(visibleRowWraps(restored.terminal)).toEqual(visibleRowWraps(source.terminal))
  expect(cursorPosition(restored.terminal)).toEqual(cursorPosition(source.terminal))
}

describe('terminal snapshot color parity', () => {
  it('preserves Codex truecolor backgrounds, BCE rows, and default trailing cells', async () => {
    const source = createRendererParityTerminal({ cols: 24, rows: 6 })
    let restored: ParityTerminal | undefined
    try {
      await writeChunksToTerminal(source.terminal, [
        '\x1b[48;2;33;58;43m\x1b[2K\x1b[0m',
        '\x1b[2;1H\x1b[48;2;74;34;29mremoved\x1b[0m',
        '\x1b[3;1H\x1b[48;2;65;69;76m> prompt\x1b[0m',
        '\x1b[4;1H\x1b[48;2;33;58;43madded\x1b[K\x1b[0m'
      ])
      restored = await restoreSerializedTerminal(source)

      expectActiveBufferParity(source, restored)
      const buffer = restored.terminal.buffer.active
      expect(buffer.getLine(0)?.getCell(0)?.getBgColor()).toBe(0x213a2b)
      expect(buffer.getLine(0)?.getCell(23)?.getBgColor()).toBe(0x213a2b)
      expect(buffer.getLine(1)?.getCell(6)?.getBgColor()).toBe(0x4a221d)
      expect(buffer.getLine(1)?.getCell(7)?.getBgColor()).toBe(-1)
      expect(buffer.getLine(2)?.getCell(0)?.getBgColor()).toBe(0x41454c)
    } finally {
      source.terminal.dispose()
      restored?.terminal.dispose()
    }
  })

  it('preserves styled scrollback in the normal buffer', async () => {
    const source = createRendererParityTerminal({ cols: 18, rows: 3 })
    let restored: ParityTerminal | undefined
    try {
      const lines = Array.from(
        { length: 7 },
        (_, index) =>
          `\x1b[48;2;${33 + index};${58 + index};${43 + index}mline-${index}\x1b[0m${index < 6 ? '\r\n' : ''}`
      )
      await writeChunksToTerminal(source.terminal, lines)
      restored = await restoreSerializedTerminal(source)

      expect(source.terminal.buffer.normal.baseY).toBeGreaterThan(0)
      expectActiveBufferParity(source, restored)
      expect(normalBufferRowsTrimmed(restored.terminal)).toEqual(
        normalBufferRowsTrimmed(source.terminal)
      )
      expect(normalBufferStylesTrimmed(restored.terminal)).toEqual(
        normalBufferStylesTrimmed(source.terminal)
      )
    } finally {
      source.terminal.dispose()
      restored?.terminal.dispose()
    }
  })

  it('preserves inverse null backgrounds without materializing wide-wrap padding', async () => {
    const source = createRendererParityTerminal({ cols: 10, rows: 4 })
    let restored: ParityTerminal | undefined
    try {
      await writeChunksToTerminal(source.terminal, [`\x1b[7m${'A'.repeat(9)}你\x1b[0m`])
      const sourcePadding = source.terminal.buffer.active.getLine(0)?.getCell(9)
      expect(sourcePadding?.getChars()).toBe('')
      expect(sourcePadding?.isInverse()).toBeTruthy()
      expect(source.terminal.buffer.active.getLine(1)?.isWrapped).toBe(true)

      restored = await restoreSerializedTerminal(source)

      expectActiveBufferParity(source, restored)
      const restoredPadding = restored.terminal.buffer.active.getLine(0)?.getCell(9)
      expect(restoredPadding?.getChars()).toBe('')
      expect(restoredPadding?.isInverse()).toBeTruthy()
    } finally {
      source.terminal.dispose()
      restored?.terminal.dispose()
    }
  })

  it('materializes final-column nulls that do not match the next wrapped glyph', async () => {
    const source = createRendererParityTerminal({ cols: 10, rows: 4 })
    let restored: ParityTerminal | undefined
    try {
      await writeChunksToTerminal(source.terminal, ['123456789你\x1b[1;9H\x1b[7m界\x1b[1;9HX'])
      const sourceNull = source.terminal.buffer.active.getLine(0)?.getCell(9)
      const nextGlyph = source.terminal.buffer.active.getLine(1)?.getCell(0)
      expect(sourceNull?.getChars()).toBe('')
      expect(sourceNull?.isInverse()).toBeTruthy()
      expect(nextGlyph?.getWidth()).toBe(2)
      expect(nextGlyph?.isInverse()).toBeFalsy()

      restored = await restoreSerializedTerminal(source)

      expect(visibleRows(restored.terminal).map((row) => row.trimEnd())).toEqual(
        visibleRows(source.terminal).map((row) => row.trimEnd())
      )
      expect(visibleRowStyles(restored.terminal)).toEqual(visibleRowStyles(source.terminal))
      expect(visibleRowWraps(restored.terminal)).toEqual(visibleRowWraps(source.terminal))
      expect(cursorPosition(restored.terminal)).toEqual(cursorPosition(source.terminal))
      const restoredBlank = restored.terminal.buffer.active.getLine(0)?.getCell(9)
      expect(restoredBlank?.getChars()).toBe(' ')
      expect(restoredBlank?.isInverse()).toBeTruthy()
    } finally {
      source.terminal.dispose()
      restored?.terminal.dispose()
    }
  })

  it('suppresses null-cell decorations when materializing an inverse background', async () => {
    const source = createRendererParityTerminal({ cols: 40, rows: 4 })
    let restored: ParityTerminal | undefined
    try {
      await writeChunksToTerminal(source.terminal, [
        `\x1b[1;30H你\x1b[H\x1b[7;4;9;53m${'A'.repeat(30)}\x1b[0m\x1b[CZ`
      ])
      const sourceNull = source.terminal.buffer.active.getLine(0)?.getCell(30)
      expect(sourceNull?.getChars()).toBe('')
      expect(sourceNull?.isInverse()).toBeTruthy()
      expect(sourceNull?.isUnderline()).toBeTruthy()
      expect(sourceNull?.isStrikethrough()).toBeTruthy()
      expect(sourceNull?.isOverline()).toBeTruthy()

      restored = await restoreSerializedTerminal(source)

      expectActiveBufferParity(source, restored)
      const restoredBlank = restored.terminal.buffer.active.getLine(0)?.getCell(30)
      expect(restoredBlank?.getChars()).toBe(' ')
      expect(restoredBlank?.isInverse()).toBeTruthy()
      expect(restoredBlank?.isUnderline()).toBeFalsy()
      expect(restoredBlank?.isStrikethrough()).toBeFalsy()
      expect(restoredBlank?.isOverline()).toBeFalsy()
    } finally {
      source.terminal.dispose()
      restored?.terminal.dispose()
    }
  })

  it('preserves the normal buffer and colored alternate-screen frame', async () => {
    const source = createRendererParityTerminal({ cols: 24, rows: 5 })
    let restored: ParityTerminal | undefined
    try {
      await writeChunksToTerminal(source.terminal, [
        '\x1b[48;2;74;34;29mshell history\x1b[0m\r\nsecond line',
        '\x1b[?1049h\x1b[2J\x1b[H',
        '\x1b[48;2;65;69;76m\x1b[2K\x1b[0m',
        '\x1b[2;1H\x1b[48;2;33;58;43mworking\x1b[K\x1b[0m'
      ])
      restored = await restoreSerializedTerminal(source)

      expect(source.terminal.buffer.active.type).toBe('alternate')
      expect(restored.terminal.buffer.active.type).toBe('alternate')
      expectActiveBufferParity(source, restored)
      expect(normalBufferRowsTrimmed(restored.terminal)).toEqual(
        normalBufferRowsTrimmed(source.terminal)
      )
      expect(normalBufferStylesTrimmed(restored.terminal)).toEqual(
        normalBufferStylesTrimmed(source.terminal)
      )
      expect(restored.terminal.buffer.active.getLine(1)?.getCell(23)?.getBgColor()).toBe(0x213a2b)
    } finally {
      source.terminal.dispose()
      restored?.terminal.dispose()
    }
  })
})
