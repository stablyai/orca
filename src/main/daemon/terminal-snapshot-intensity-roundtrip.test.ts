import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { describe, expect, it } from 'vitest'
import { serializeWithAbsoluteCursor } from '../../shared/terminal-serialize-absolute-cursor'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function intensity(terminal: Terminal, column: number): { bold: boolean; dim: boolean } {
  const buffer = terminal.buffer.active
  const cell = buffer.getLine(buffer.baseY)?.getCell(column)
  if (!cell) {
    throw new Error(`Missing cell at column ${column}`)
  }
  return { bold: Boolean(cell.isBold()), dim: Boolean(cell.isDim()) }
}

describe('alternate snapshot intensity', () => {
  it.each(['1', '2', '1;2'].flatMap((sgr) => ['', 'shell'].map((normal) => [sgr, normal])))(
    'keeps the live SGR %s pen out of alternate cells after %s',
    async (sgr, normal) => {
      const source = new Terminal({ cols: 20, rows: 5, allowProposedApi: true })
      const restored = new Terminal({ cols: 20, rows: 5, allowProposedApi: true })
      const addon = new SerializeAddon()
      source.loadAddon(addon)
      try {
        await write(source, `${normal}\x1b[?1049h\x1b[38;5;173m◆\x1b[0m plain\x1b[${sgr}mX`)
        await write(restored, serializeWithAbsoluteCursor(addon, source))
        expect(restored.buffer.active.type).toBe('alternate')
        expect(restored.buffer.normal.getLine(0)?.translateToString(true)).toBe(normal)
        for (let column = 0; column < 8; column++) {
          expect(intensity(restored, column)).toEqual(intensity(source, column))
        }
        await write(source, 'Y')
        await write(restored, 'Y')
        expect(intensity(restored, 8)).toEqual(intensity(source, 8))
      } finally {
        source.dispose()
        restored.dispose()
      }
    }
  )
})
