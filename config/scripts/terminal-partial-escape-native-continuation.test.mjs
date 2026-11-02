import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { advancePartialEscapeTail } from '../../src/shared/terminal-partial-escape-tail'

const require = createRequire(import.meta.url)
const { Terminal } = require(process.env.ORCA_PARTIAL_ESCAPE_HEADLESS ?? '@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize')

function model() {
  const terminal = new Terminal({ cols: 40, rows: 6, allowProposedApi: true, logLevel: 'off' })
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer)
  const effects = []
  for (const id of [2, 7, 8, 52, 1337]) {
    terminal.parser.registerOscHandler(id, (data) => {
      effects.push(['osc', id, data])
      return true
    })
  }
  terminal.parser.registerDcsHandler({ final: 'q' }, (data) => {
    effects.push(['dcs', data])
    return true
  })
  terminal.onData((data) => effects.push(['reply', data]))
  return { terminal, serializer, effects }
}

const write = (h, data) => h.terminal._core.writeSync(data)
const state = (h) => h.terminal._core._inputHandler._parser.currentState
const screen = (h) => {
  const buffer = h.terminal.buffer.active
  return {
    cursor: [buffer.cursorX, buffer.cursorY],
    rows: Array.from({ length: buffer.length }, (_, row) => {
      const line = buffer.getLine(row)
      return Array.from({ length: line.length }, (_, column) => {
        const cell = line.getCell(column)
        return [cell.getChars(), cell.getWidth(), cell.getFgColor(), cell.getBgColor()]
      })
    })
  }
}

function compareContinuation(source, restored, prefix, continuation) {
  source.terminal.reset()
  restored.terminal.reset()
  source.effects.length = 0
  restored.effects.length = 0
  write(source, `BEFORE${prefix}\x1b`)
  const serialized = source.serializer.serialize()
  const pending = advancePartialEscapeTail('', `BEFORE${prefix}\x1b`)
  source.effects.length = 0
  write(restored, serialized + pending)
  expect(restored.effects, JSON.stringify({ prefix, continuation })).toEqual([])
  expect(state(restored)).toBe(state(source))
  write(source, continuation)
  write(restored, continuation)
  expect(screen(restored), JSON.stringify({ prefix, continuation })).toEqual(screen(source))
  expect(state(restored)).toBe(state(source))
  expect(restored.effects).toEqual(source.effects)
}

const prefixes = [
  '\x1b]2;title',
  '\x1b]7;file:///original',
  '\x1b]8;;https://example.com',
  '\x1b]52;c;aGVsbG8=',
  '\x1b]1337;File=inline=1:AAAA',
  '\x1bPqpayload',
  '\x1b_Gpayload',
  '\x1bXpayload',
  '\x1b^payload'
]

describe('completed string continuation against the native terminal parser', () => {
  it.each(prefixes)('matches uninterrupted output for every following byte after %j', (prefix) => {
    const source = model()
    const restored = model()
    try {
      for (let byte = 0; byte < 256; byte++) {
        compareContinuation(source, restored, prefix, `${String.fromCharCode(byte)}AFTER`)
      }
    } finally {
      source.terminal.dispose()
      restored.terminal.dispose()
    }
  })

  it.each([0, 32, 4095, 4096, 4097, 8192])(
    'does not repeat completed side effects for a %i-character payload',
    (length) => {
      const source = model()
      const restored = model()
      try {
        for (const introducer of ['\x1b]2;', '\x1b]7;', '\x1b]52;', '\x1bPq']) {
          for (const continuation of [
            '\\AFTER',
            '[32mAFTER',
            '\x18AFTER',
            '\x1aAFTER',
            '\x1b]7;file:///next\x07AFTER',
            '\x1bPqnext\x1b\\AFTER'
          ]) {
            compareContinuation(source, restored, introducer + 'x'.repeat(length), continuation)
          }
        }
      } finally {
        source.terminal.dispose()
        restored.terminal.dispose()
      }
    }
  )
})
