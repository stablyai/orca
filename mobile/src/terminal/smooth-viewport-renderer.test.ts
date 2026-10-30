import { describe, expect, it } from 'vitest'
import { createSmoothWebglAddon, setTerminalScrollOffset } from './smooth-viewport-renderer.mjs'

type Dimensions = {
  css: { cell: { height: number }; canvas: { height: number; width: number } }
  device: { cell: { height: number }; canvas: { height: number; width: number } }
}
type RendererDouble = {
  _gl: object
  dimensions: Dimensions
  disposed: boolean
  handleResize: () => void
  renderRows: (start: number, end: number) => void
  dispose: () => void
}
type RenderService = { _renderer: { value: unknown }; setRenderer: (renderer: unknown) => void }
type TerminalDouble = {
  rows: number
  cols: number
  element: { style: Record<string, string> }
  buffer: { active: { type: string; viewportY: number; baseY: number } }
  _core: {
    rows: number
    screenElement: { style: Record<string, string> }
    _renderService: RenderService
  }
}
function dimensions(rows: number): Dimensions {
  return {
    css: { cell: { height: 17 }, canvas: { height: rows * 17, width: 400 } },
    device: { cell: { height: 51 }, canvas: { height: rows * 51, width: 1200 } }
  }
}
function fixture() {
  const service: RenderService = {
    _renderer: { value: null },
    setRenderer(renderer) {
      this._renderer.value = renderer
    }
  }
  const terminal: TerminalDouble = {
    rows: 36,
    cols: 50,
    element: { style: {} },
    buffer: { active: { type: 'normal', viewportY: 500, baseY: 965 } },
    _core: { rows: 36, screenElement: { style: {} }, _renderService: service }
  }
  const draws: { start: number; end: number; viewport: number }[] = []
  class Addon {
    activate(view: TerminalDouble) {
      const renderer: RendererDouble = {
        _gl: {},
        dimensions: dimensions(view.rows),
        disposed: false,
        handleResize() {
          this.dimensions = dimensions(view.rows)
        },
        renderRows(start, end) {
          draws.push({ start, end, viewport: view.buffer.active.viewportY })
        },
        dispose() {
          this.disposed = true
        }
      }
      renderer.handleResize()
      view._core._renderService.setRenderer(renderer)
    }
  }
  const addon = new (createSmoothWebglAddon(Addon))()
  addon.activate(terminal)
  // SAFETY: this controlled addon installs exactly the RendererDouble through the wrapper.
  const renderer = service._renderer.value as RendererDouble
  return { terminal, service, renderer, draws }
}

describe('fractional viewport renderer boundaries', () => {
  it('draws the adjacent row without changing the parser or public viewport geometry', () => {
    const { terminal, renderer, draws } = fixture()
    expect(setTerminalScrollOffset(terminal, -8)).toBe(true)
    expect(terminal.rows).toBe(36)
    expect(terminal._core.rows).toBe(36)
    expect(renderer.dimensions.css.canvas.height).toBe(612)
    expect(renderer.dimensions.device.canvas.height).toBe(1836)
    expect(draws.at(-1)).toEqual({ start: 0, end: 37, viewport: 500 })
    expect(terminal._core.screenElement.style.transform).toBe('translateY(-8px)')
    expect(terminal.element.style.overflow).toBe('visible')
  })

  it('keeps a row drawn while it still shows in the remainder below a shifted grid', () => {
    const { terminal, draws } = fixture()
    setTerminalScrollOffset(terminal, -1)
    terminal.buffer.active.viewportY--
    setTerminalScrollOffset(terminal, -16)
    // Row 536 sat at the grid's floor before the wrap; after it, it is the second row below.
    expect(draws.at(-1)).toEqual({ start: 0, end: 37, viewport: 499 })
  })

  it('draws only the rows that exist one row above the bottom', () => {
    const { terminal, draws } = fixture()
    terminal.buffer.active.viewportY = terminal.buffer.active.baseY - 1
    setTerminalScrollOffset(terminal, -8)
    expect(draws.at(-1)).toEqual({ start: 0, end: 36, viewport: 964 })
  })

  it('paints the new row before applying its fractional offset', () => {
    const { terminal, draws } = fixture()
    setTerminalScrollOffset(terminal, -8)
    terminal.buffer.active.viewportY--
    setTerminalScrollOffset(terminal, -2)
    expect(draws.map((d) => d.viewport)).toEqual([500, 499])
    expect(terminal._core.screenElement.style.transform).toBe('translateY(-2px)')
  })

  it.each(['bottom', 'alternate'])('drops overscan and offset at the %s boundary', (boundary) => {
    const { terminal, renderer, draws } = fixture()
    setTerminalScrollOffset(terminal, -8)
    if (boundary === 'bottom') {
      terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    } else {
      terminal.buffer.active.type = 'alternate'
    }
    renderer.renderRows(0, terminal.rows - 1)
    expect(terminal._core.screenElement.style.transform).toBe('')
    expect(draws.at(-1)?.end).toBe(35)
    expect(renderer.dimensions.css.canvas.height).toBe(612)
  })

  it('refuses unsupported renderers and invalid offsets', () => {
    const { terminal } = fixture()
    expect(setTerminalScrollOffset(terminal, Number.NaN)).toBe(false)
    terminal._core._renderService._renderer.value = {}
    expect(setTerminalScrollOffset(terminal, -8)).toBe(false)
  })
})
