import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')

function write(terminal, text) {
  return new Promise((resolve) => terminal.write(text, resolve))
}

it('retains underline color without drawing an underline, including explicit white and reset', async () => {
  const terminal = new Terminal({ allowProposedApi: true })
  try {
    await write(terminal, '\x1b[58;2;0;0;10mA\x1b[58;2;255;255;255mB\x1b[59mC')
    const line = terminal._core.buffer.lines.get(0)
    expect(line._extendedAttrs[0].underlineColor & 0xffffff).toBe(10)
    expect(line._extendedAttrs[0].underlineStyle).toBe(0)
    expect(line._extendedAttrs[1].underlineColor & 0xffffff).toBe(0xffffff)
    expect(line._extendedAttrs[1].underlineStyle).toBe(0)
    expect(line._extendedAttrs[2]).toBeUndefined()
    await write(terminal, '\x1b[4mD')
    expect(line._extendedAttrs[3].underlineStyle).toBe(1)
    expect(line._extendedAttrs[3].underlineColor).toBe(0)
  } finally {
    terminal.dispose()
  }
})
