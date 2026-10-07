import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal: BrowserTerminal } = require('@xterm/xterm')
const { Terminal: HeadlessTerminal } = require('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize')

function write(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function colors(terminal, count) {
  const line = terminal.buffer.active.getLine(0)
  return Array.from({ length: count }, (_, col) => {
    const cell = line.getCell(col)
    const encoded = cell.hasExtendedAttrs() ? cell.extended.underlineColor : 0
    const mode = encoded & 0x03000000
    return {
      text: cell.getChars(),
      underline: Boolean(cell.isUnderline()),
      color: mode ? encoded & 0xffffff : null,
      rgb: mode === 0x03000000
    }
  })
}

for (const { name, Terminal } of [
  { name: 'browser', Terminal: BrowserTerminal },
  { name: 'headless', Terminal: HeadlessTerminal }
]) {
  it(`${name}: named placeholder colors survive serialization without visible underlines`, async () => {
    const original = new Terminal({ cols: 30, rows: 5, allowProposedApi: true })
    const restored = new BrowserTerminal({ cols: 30, rows: 5, allowProposedApi: true })
    const serializer = new SerializeAddon()
    original.loadAddon(serializer)
    try {
      await write(
        original,
        '\x1b[38;2;0;255;0m\x1b[58;2;0;0;10m\u{10EEEE}\u0305' +
          '\x1b[58;2;255;255;255m\u{10EEEE}\u030D' +
          '\x1b[58;5;42m\u{10EEEE}\u030E\x1b[59mD\x1b[0mE'
      )
      const expected = [
        { text: '\u{10EEEE}\u0305', underline: false, color: 10, rgb: true },
        { text: '\u{10EEEE}\u030D', underline: false, color: 0xffffff, rgb: true },
        { text: '\u{10EEEE}\u030E', underline: false, color: 42, rgb: false },
        { text: 'D', underline: false, color: null, rgb: false },
        { text: 'E', underline: false, color: null, rgb: false }
      ]
      expect(colors(original, 5)).toEqual(expected)
      await write(restored, serializer.serialize())
      expect(colors(restored, 5)).toEqual(expected)
    } finally {
      restored.dispose()
      original.dispose()
    }
  })

  it(`${name}: underline color transitions preserve style and reset independently`, async () => {
    const original = new Terminal({ cols: 30, rows: 5, allowProposedApi: true })
    const restored = new BrowserTerminal({ cols: 30, rows: 5, allowProposedApi: true })
    const serializer = new SerializeAddon()
    original.loadAddon(serializer)
    try {
      await write(original, '\x1b[58;2;1;2;3mA\x1b[4mB\x1b[59mC\x1b[24mD')
      const expected = [
        { text: 'A', underline: false, color: 0x010203, rgb: true },
        { text: 'B', underline: true, color: 0x010203, rgb: true },
        { text: 'C', underline: true, color: null, rgb: false },
        { text: 'D', underline: false, color: null, rgb: false }
      ]
      expect(colors(original, 4)).toEqual(expected)
      await write(restored, serializer.serialize())
      expect(colors(restored, 4)).toEqual(expected)
    } finally {
      restored.dispose()
      original.dispose()
    }
  })

  it(`${name}: a saved pen carries the placement ID into later placeholder output`, async () => {
    const original = new Terminal({ cols: 30, rows: 5, allowProposedApi: true })
    const restored = new BrowserTerminal({ cols: 30, rows: 5, allowProposedApi: true })
    const serializer = new SerializeAddon()
    original.loadAddon(serializer)
    try {
      await write(original, '\x1b[38;2;0;255;0m\x1b[58;2;0;0;99m')
      await write(restored, serializer.serialize())
      await write(restored, '\u{10EEEE}\u0305')
      expect(colors(restored, 1)).toEqual([
        { text: '\u{10EEEE}\u0305', underline: false, color: 99, rgb: true }
      ])
    } finally {
      restored.dispose()
      original.dispose()
    }
  })

  it(`${name}: foreground-colored underlines remain implicit through a snapshot`, async () => {
    const original = new Terminal({ cols: 30, rows: 5, allowProposedApi: true })
    const restored = new BrowserTerminal({ cols: 30, rows: 5, allowProposedApi: true })
    const serializer = new SerializeAddon()
    original.loadAddon(serializer)
    try {
      await write(original, '\x1b[38;2;1;2;3m\x1b[4mA\x1b[38;2;4;5;6mB')
      await write(restored, serializer.serialize())
      expect(colors(restored, 2)).toEqual([
        { text: 'A', underline: true, color: null, rgb: false },
        { text: 'B', underline: true, color: null, rgb: false }
      ])
      await write(restored, '\x1b[38;2;7;8;9mC')
      expect(restored.buffer.active.getLine(0).getCell(2).getUnderlineColor()).toBe(0x070809)
    } finally {
      restored.dispose()
      original.dispose()
    }
  })
}
