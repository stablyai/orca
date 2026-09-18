// @vitest-environment happy-dom
import { Script } from 'node:vm'
import { expect, it } from 'vitest'
import { XTERM_ENGINE_JS } from './terminal-webview-engine.generated'

type ReflowTerminal = {
  resize(cols: number, rows: number): void
  dispose(): void
  _core: {
    writeSync(data: string): void
    buffer: {
      lines: {
        length: number
        _array: unknown[]
        get(index: number): { translateToString(trim: boolean): string }
      }
    }
  }
}

it.each([0, 37])(
  'keeps the retained tail without negative slots in the mobile engine, ring start: %s',
  (prefixRows) => {
    const Terminal: new (options: Record<string, unknown>) => ReflowTerminal = new Script(
      `${XTERM_ENGINE_JS}\nwindow.Terminal`
    ).runInThisContext()
    const capacity = 128
    const rows = 8
    const terminal = new Terminal({ cols: 80, rows, scrollback: capacity - rows, logLevel: 'off' })
    try {
      const words = Array.from({ length: (capacity - 1) * 4 }, (_, index) =>
        String(index).padStart(20, '0')
      )
      terminal._core.writeSync(`${'prefix\r\n'.repeat(prefixRows)}${words.join('')}\r\n`)
      terminal.resize(20, rows)
      const lines = terminal._core.buffer.lines
      expect(
        Array.from({ length: lines.length }, (_, index) => lines.get(index).translateToString(true))
      ).toEqual([...words, ''].slice(-capacity))
      expect(Object.keys(lines._array).filter((key) => Number(key) < 0)).toEqual([])
    } finally {
      terminal.dispose()
    }
  }
)
