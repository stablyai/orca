// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'

function renderDimensions(cellHeight) {
  const cell = { width: 8, height: cellHeight }
  const canvas = { width: 80 * 8, height: 20 * cellHeight }
  return {
    css: { cell, canvas },
    device: { cell, canvas, char: { ...cell, left: 0, top: 0 } }
  }
}

function openTerminal() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    new Proxy(
      {},
      { get: (_target, key) => (key === 'measureText' ? () => ({ width: 8 }) : () => {}) }
    )
  )
  const element = document.createElement('div')
  document.body.appendChild(element)
  const terminal = new Terminal({ rows: 20, cols: 80, scrollback: 500 })
  terminal.open(element)
  // happy-dom has no layout, so stand in for a renderer whose cell size we control.
  const renderer = {
    dimensions: renderDimensions(17),
    onRequestRedraw: () => ({ dispose() {} })
  }
  for (const method of [
    'dispose',
    'handleDevicePixelRatioChange',
    'handleResize',
    'handleCharSizeChanged',
    'handleBlur',
    'handleFocus',
    'handleSelectionChanged',
    'handleCursorMove',
    'clear',
    'renderRows',
    'clearTextureAtlas'
  ]) {
    renderer[method] = () => {}
  }
  terminal._core._renderService.setRenderer(renderer)
  return { terminal, renderer }
}

const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve))
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
const lines = (count, prefix) =>
  Array.from({ length: count }, (_, i) => `\r\n${prefix}${i}`).join('')

afterEach(() => vi.restoreAllMocks())

describe('xterm viewport with an unmeasured cell height', () => {
  it('does not spin on scroll sync and follows output once cells are measured again', async () => {
    const { terminal, renderer } = openTerminal()
    // Unpatched, xterm loops forever on the NaN row inside one frame; cap it so the test fails instead of exhausting memory.
    let scrollEventsThisTask = 0
    let runaway = false
    const scrollSubscription = terminal.onScroll(() => {
      scrollEventsThisTask += 1
      queueMicrotask(() => (scrollEventsThisTask = 0))
      if (scrollEventsThisTask > 1000) {
        runaway = true
        throw new Error('scroll sync loop')
      }
    })
    try {
      await write(terminal, lines(100, 'before'))
      await nextFrame()

      // A renderer with no measured cells (0 height) while output streams in: the viewport would
      // read its scroll offset back as row 0/0 = NaN.
      renderer.dimensions = renderDimensions(0)
      await write(terminal, lines(5, 'unmeasured'))
      await nextFrame()
      expect(runaway).toBe(false)
      expect(Number.isFinite(terminal.buffer.active.viewportY)).toBe(true)

      // Keyboard and API scrolling still move the view while cells are unmeasured.
      terminal.scrollLines(-10)
      expect(terminal.buffer.active.viewportY).toBe(76)
      terminal.scrollToBottom()

      renderer.dimensions = renderDimensions(17)
      await write(terminal, lines(5, 'after'))
      await nextFrame()
      expect(runaway).toBe(false)
      expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
      expect(terminal.buffer.active.baseY).toBe(91)
    } finally {
      scrollSubscription.dispose()
      terminal.dispose()
    }
  })
})
