import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const variants = []
for (const name of ['@xterm/headless', '@xterm/xterm']) {
  const root = path.dirname(require.resolve(`${name}/package.json`))
  const entry = name === '@xterm/headless' ? 'lib-headless/xterm-headless.mjs' : 'lib/xterm.mjs'
  variants.push({ name: `${name} CJS`, Terminal: require(name).Terminal })
  variants.push({
    name: `${name} ESM`,
    Terminal: (await import(pathToFileURL(path.join(root, entry)))).Terminal
  })
}

function write(terminal, text) {
  return new Promise((resolve) => terminal.write(text, resolve))
}

for (const variant of variants) {
  describe(`${variant.name} reflow retention`, () => {
    for (const prefixRows of [0, 37]) {
      it(`keeps only the correct tail when the circular start is ${prefixRows}`, async () => {
        const capacity = 128
        const rows = 8
        const terminal = new variant.Terminal({
          cols: 80,
          rows,
          scrollback: capacity - rows,
          allowProposedApi: true,
          logLevel: 'off'
        })
        try {
          const words = Array.from({ length: (capacity - 1) * 10 }, (_, index) =>
            String(index).padStart(8, '0')
          )
          await write(terminal, `${'prefix\r\n'.repeat(prefixRows)}${words.join('')}\r\n`)
          const cursorMarker = terminal.registerMarker(0)
          const retiredMarker = terminal.registerMarker(-(capacity - 1))
          terminal.resize(8, rows)
          const buffer = terminal.buffer.active
          const actual = Array.from({ length: buffer.length }, (_, index) =>
            buffer.getLine(index).translateToString(true)
          )
          expect(actual).toEqual([...words, ''].slice(-capacity))
          expect(buffer.length).toBe(capacity)
          expect(buffer.cursorX).toBe(0)
          expect(buffer.cursorY).toBe(rows - 1)
          expect(cursorMarker.isDisposed).toBe(false)
          expect(cursorMarker.line).toBe(capacity - 1)
          expect(retiredMarker.isDisposed).toBe(true)
          // Negative array properties retain rows outside the public scrollback length.
          const array = terminal._core._bufferService.buffer.lines._array
          expect(Object.keys(array).filter((key) => Number(key) < 0)).toEqual([])
        } finally {
          terminal.dispose()
        }
      })
    }
  })
}
