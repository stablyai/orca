// Why: xterm scrolls and paints whole rows, so a finger's sub-row travel had nothing to move.
// The parser keeps its whole-row viewportY; only the renderer is wrapped, painting rows past the
// grid's floor and shifting the screen by the remainder. It reaches xterm internals that the
// pinned @xterm/xterm and @xterm/addon-webgl versions expose.
const controllers = new WeakMap()

// Why: the grid sits on a sub-row remainder, so a viewport shifted up by up to a row shows parts
// of two rows below it. One overscan row let a nearly visible row vanish when the offset wrapped.
const OVERSCAN_ROWS = 2

function extraRows(terminal) {
  const buffer = terminal.buffer.active
  return buffer.type === 'normal'
    ? Math.max(0, Math.min(OVERSCAN_ROWS, buffer.baseY - buffer.viewportY))
    : 0
}

function bindProperty(target, property) {
  const value = Reflect.get(target, property, target)
  return typeof value === 'function' ? value.bind(target) : value
}

function makeWebglRenderer(renderer, terminal) {
  let offset = 0
  let paintedViewport = -1
  let geometryRows = terminal.rows + extraRows(terminal)
  let resizing = false
  let logicalDimensions
  let geometryKey = ''
  const dimensions = () => {
    const d = renderer.dimensions
    const key = [
      terminal.rows,
      terminal.cols,
      d.css.cell.height,
      d.device.cell.height,
      d.css.canvas.width,
      d.device.canvas.width
    ].join(':')
    if (key !== geometryKey) {
      geometryKey = key
      logicalDimensions = {
        ...d,
        css: { ...d.css, canvas: { ...d.css.canvas, height: terminal.rows * d.css.cell.height } },
        device: {
          ...d.device,
          canvas: { ...d.device.canvas, height: terminal.rows * d.device.cell.height }
        }
      }
    }
    return logicalDimensions
  }
  const paint = () => {
    if (!extraRows(terminal)) {
      offset = 0
    }
    // Why: #terminal-container clips at the real viewport edge; clipping here cut the overscan row
    // at the grid's floor and left the sub-row remainder above the accessory bar blank.
    terminal.element.style.overflow = 'visible'
    const screen = terminal._core.screenElement
    screen.style.height = terminal.rows * renderer.dimensions.css.cell.height + 'px'
    screen.style.transform = offset === 0 ? '' : `translateY(${offset}px)`
  }
  const resize = () => {
    if (resizing) {
      return
    }
    resizing = true
    geometryRows = terminal.rows + extraRows(terminal)
    if (!extraRows(terminal)) {
      offset = 0
    }
    try {
      renderer.handleResize(terminal.cols, terminal.rows)
    } finally {
      resizing = false
      paint()
    }
  }
  const renderRows = (start, end) => {
    if (!resizing && geometryRows !== terminal.rows + extraRows(terminal)) {
      resize()
    }
    renderer.renderRows(start, end >= terminal.rows - 1 ? geometryRows - 1 : end)
    paintedViewport = terminal.buffer.active.viewportY
    paint()
  }
  const controller = {
    setOffset(value) {
      if (!Number.isFinite(value)) {
        return false
      }
      if (geometryRows !== terminal.rows + extraRows(terminal)) {
        resize()
      }
      offset = extraRows(terminal)
        ? Math.min(0, Math.max(-renderer.dimensions.css.cell.height, value))
        : 0
      if (paintedViewport !== terminal.buffer.active.viewportY) {
        renderRows(0, terminal.rows - 1)
      } else {
        paint()
      }
      return true
    }
  }
  const wrapped = new Proxy(renderer, {
    get(target, property) {
      if (property === 'dimensions') {
        return dimensions()
      }
      if (property === 'renderRows') {
        return renderRows
      }
      if (property === 'handleResize') {
        return resize
      }
      return bindProperty(target, property)
    }
  })
  controllers.set(wrapped, controller)
  paint()
  return wrapped
}

function domController(renderer, terminal) {
  const renderRows = renderer.renderRows
  const handleResize = renderer.handleResize
  let offset = 0
  let renderedRows = terminal.rows
  let resizing = false
  let paintedViewport = -1
  const paint = () => {
    if (!extraRows(terminal)) {
      offset = 0
    }
    terminal.element.style.overflow = 'visible'
    terminal._core.screenElement.style.transform = offset === 0 ? '' : `translateY(${offset}px)`
  }
  const resize = () => {
    if (resizing) {
      return
    }
    resizing = true
    renderedRows = terminal.rows + extraRows(terminal)
    if (!extraRows(terminal)) {
      offset = 0
    }
    try {
      handleResize.call(renderer, terminal.cols, renderedRows)
    } finally {
      resizing = false
      paint()
    }
  }
  renderer.handleResize = resize
  renderer.renderRows = (start, end) => {
    if (!resizing && renderedRows !== terminal.rows + extraRows(terminal)) {
      resize()
    }
    renderRows.call(renderer, start, end >= terminal.rows - 1 ? renderedRows - 1 : end)
    paintedViewport = terminal.buffer.active.viewportY
    paint()
  }
  const controller = {
    setOffset(value) {
      if (!Number.isFinite(value)) {
        return false
      }
      if (renderedRows !== terminal.rows + extraRows(terminal)) {
        resize()
      }
      offset = extraRows(terminal)
        ? Math.min(0, Math.max(-renderer.dimensions.css.cell.height, value))
        : 0
      if (paintedViewport !== terminal.buffer.active.viewportY) {
        renderer.renderRows(0, terminal.rows - 1)
      } else {
        paint()
      }
      return true
    }
  }
  controllers.set(renderer, controller)
  return controller
}

/**
 * xterm's WebGL addon, drawing the rows a sub-row offset brings into view below the grid.
 * @template T
 * @param {T} BaseAddon
 * @returns {T}
 */
export function createSmoothWebglAddon(BaseAddon) {
  return class SmoothWebglAddon extends BaseAddon {
    activate(terminal) {
      const core = terminal._core
      const renderService = core._renderService
      const renderProxy = new Proxy(renderService, {
        get(target, property) {
          if (property === 'setRenderer') {
            return (renderer) =>
              target.setRenderer(renderer?._gl ? makeWebglRenderer(renderer, terminal) : renderer)
          }
          if (property === 'handleResize') {
            return () => target.handleResize(terminal.cols, terminal.rows)
          }
          return bindProperty(target, property)
        }
      })
      const coreProxy = new Proxy(core, {
        get(target, property) {
          if (property === 'rows') {
            return terminal.rows + extraRows(terminal)
          }
          if (property === '_renderService') {
            return renderProxy
          }
          return bindProperty(target, property)
        }
      })
      const terminalProxy = new Proxy(terminal, {
        get(target, property) {
          if (property === 'rows') {
            return terminal.rows + extraRows(terminal)
          }
          if (property === '_core') {
            return coreProxy
          }
          return bindProperty(target, property)
        }
      })
      super.activate(terminalProxy)
    }
  }
}

/**
 * xterm's terminal with the document's `setViewportPixelOffset` seam.
 * @template T
 * @param {T} BaseTerminal
 * @returns {T}
 */
export function createSmoothTerminal(BaseTerminal) {
  return class SmoothTerminal extends BaseTerminal {
    setViewportPixelOffset(offset) {
      return setTerminalScrollOffset(this, offset)
    }
  }
}

/**
 * Shifts the drawn rows up by a sub-row offset in unscaled CSS px; false when the renderer cannot.
 * @param {any} terminal
 * @param {number} value
 * @returns {boolean}
 */
export function setTerminalScrollOffset(terminal, value) {
  const renderer = terminal?._core?._renderService?._renderer?.value
  if (!renderer) {
    return false
  }
  let controller = controllers.get(renderer)
  if (
    !controller &&
    Array.isArray(renderer._rowElements) &&
    typeof renderer.handleResize === 'function'
  ) {
    controller = domController(renderer, terminal)
  }
  return controller?.setOffset(value) ?? false
}
