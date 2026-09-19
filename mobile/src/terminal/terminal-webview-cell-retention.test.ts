// @vitest-environment happy-dom
import { Script } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { XTERM_ENGINE_JS } from './terminal-webview-engine.generated'

type Line = {
  _combined: Record<number, string>
  _cache: string
  getString(index: number): string
  translateToString(trim?: boolean): string
  copyCellsFrom(source: Line, start: number, target: number, count: number, reverse: boolean): void
}
type BundledTerminal = {
  open(element: HTMLElement): void
  dispose(): void
  _core: { writeSync(data: string): void; buffer: { lines: { get(row: number): Line } } }
}

let terminal: BundledTerminal | undefined

afterEach(() => {
  terminal?.dispose()
  terminal = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it.each([false, true])(
  'releases dead cell text in the generated mobile engine, alternate: %s',
  (alternate) => {
    vi.stubGlobal('OffscreenCanvas', undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the DOM font probe only reads font and measureText from this canvas context.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: () => ({ width: 8 })
    } as unknown as CanvasRenderingContext2D)
    const Terminal: new (options: Record<string, unknown>) => BundledTerminal = new Script(
      `${XTERM_ENGINE_JS}\nwindow.Terminal`
    ).runInThisContext()
    terminal = new Terminal({ cols: 8, rows: 3, scrollback: 0, logLevel: 'off' })
    const element = document.createElement('div')
    document.body.append(element)
    terminal.open(element)
    const write = (data: string): void => terminal!._core.writeSync(data)
    if (alternate) {
      write('\x1b[?1049h')
    }
    const text = `a${'\u0301'.repeat(1024)}`
    write(text)
    const row = terminal._core.buffer.lines.get(0)
    expect(row.getString(0)).toBe(text)
    expect(row.translateToString(true)).toBe(text)
    write('\rZ')
    expect(Object.keys(row._combined)).toHaveLength(0)
    expect(row._cache).toBe('')
    write('\rA\u0301BC')
    row.copyCellsFrom(row, 0, 1, 3, true)
    expect(Array.from({ length: 4 }, (_, index) => row.getString(index))).toEqual([
      'A\u0301',
      'A\u0301',
      'B',
      'C'
    ])
    write('\r\x1b[2K')
    expect(Object.keys(row._combined)).toHaveLength(0)
    expect(row.translateToString(true)).toBe('')
  }
)
