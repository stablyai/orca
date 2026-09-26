// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_TEXT_SCALES } from '../terminal-text-scales'
import { laidOutCellMetrics, measureCellMetrics, reportLaidOutCellBox } from './cell-metrics-probe'
import { createTerminalDocumentScope } from './document-scope'
import { startTerminalDocument, stopTerminalDocument } from './create-terminal-document'
import type { TerminalDocumentHost } from './document-host-seams'
import { fontPxForScale } from './text-scaling'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { handleMsg } from './host-message-router'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html/document-markup'

const DPR = 3

/** A canvas whose 'W' is 0.6em wide and 1.17em tall, reading the font the probe sets. */
class FakeOffscreenCanvas {
  getContext() {
    let px = 10
    return {
      set font(value: string) {
        px = Number.parseFloat(value)
      },
      measureText: () => ({
        width: px * 0.6,
        fontBoundingBoxAscent: px * 0.93,
        fontBoundingBoxDescent: px * 0.24
      })
    }
  }
}

const webglAddon = () => ({ dispose: vi.fn() })

function probeScope(host: TerminalDocumentHost = {}) {
  return createTerminalDocumentScope({ createWebglAddon: webglAddon, ...host })
}

function expectedCell(fontScale: number, snapsWidth: boolean) {
  const px = fontPxForScale(fontScale)
  const deviceWidth = snapsWidth ? Math.floor(px * 0.6 * DPR) : px * 0.6 * DPR
  return {
    fontScale,
    cellWidth: deviceWidth / DPR,
    cellHeight: Math.ceil((px * 0.93 + px * 0.24) * DPR) / DPR
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('measureCellMetrics', () => {
  it('reports every text-size preset, width snapped to device pixels as the WebGL renderer does', () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('WebGL2RenderingContext', class {})
    vi.stubGlobal('devicePixelRatio', DPR)
    expect(measureCellMetrics(probeScope())).toEqual(
      TERMINAL_TEXT_SCALES.map((scale) => expectedCell(scale, true))
    )
  })

  it('leaves the width unsnapped when init will fall back to the DOM renderer', () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('devicePixelRatio', DPR)
    vi.stubGlobal('WebGL2RenderingContext', class {})
    expect(measureCellMetrics(probeScope({ createWebglAddon: () => null }))[2]).toEqual(
      expectedCell(1, false)
    )
    vi.stubGlobal('WebGL2RenderingContext', undefined)
    expect(measureCellMetrics(probeScope())[2]).toEqual(expectedCell(1, false))
  })

  it('reports nothing when the font cannot be measured, so the host falls back', () => {
    // happy-dom has no OffscreenCanvas and lays out nothing: the DOM run measures 0.
    expect(measureCellMetrics(probeScope())).toEqual([])
  })
})

describe('laidOutCellMetrics', () => {
  function scopeWithCell(
    cell: { width: number; height: number },
    fontSize: number,
    posted: Record<string, unknown>[] = []
  ) {
    const scope = probeScope({ postToHost: (message) => posted.push(message) })
    scope.currentTextScale = 1.25
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader touches only options.fontSize and _core's render dimensions.
    scope.term = {
      cols: 55,
      rows: 47,
      options: { fontSize },
      _core: { _renderService: { dimensions: { css: { cell } } } }
    } as unknown as typeof scope.term
    return scope
  }

  it('reports the box xterm laid out, keyed by the scale it was opened at', () => {
    const scope = scopeWithCell({ width: 29 / 3, height: 21 }, fontPxForScale(1.25))
    expect(laidOutCellMetrics(scope)).toEqual([
      { fontScale: 1.25, cellWidth: 29 / 3, cellHeight: 21 }
    ])
  })

  it('tells the host each new laid-out box once, with the grid it belongs to', () => {
    const posted: Record<string, unknown>[] = []
    const cell = { width: 29 / 3, height: 21 }
    const scope = scopeWithCell(cell, fontPxForScale(1.25), posted)
    reportLaidOutCellBox(scope)
    reportLaidOutCellBox(scope)
    // A renderer swap after context loss: the DOM renderer does not snap the width.
    cell.width = 9.75
    reportLaidOutCellBox(scope)
    expect(posted).toEqual([
      {
        type: 'cell-metrics',
        cellMetrics: [{ fontScale: 1.25, cellWidth: 29 / 3, cellHeight: 21 }],
        cols: 55,
        rows: 47
      },
      {
        type: 'cell-metrics',
        cellMetrics: [{ fontScale: 1.25, cellWidth: 9.75, cellHeight: 21 }],
        cols: 55,
        rows: 47
      }
    ])
  })

  it('reports nothing while a text-size change is between font and scale', () => {
    const scope = scopeWithCell({ width: 29 / 3, height: 21 }, fontPxForScale(1))
    expect(laidOutCellMetrics(scope)).toEqual([])
  })
})

describe('web-ready', () => {
  it('carries the cell table and the viewport it was measured against', () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('WebGL2RenderingContext', class {})
    vi.stubGlobal('devicePixelRatio', DPR)
    document.body.innerHTML =
      '<div id="terminal-container"><div id="terminal-surface"></div></div>' +
      '<div id="selection-overlay"><div id="sel-handle-start"></div>' +
      '<div id="sel-handle-end"></div><div id="sel-menu">' +
      '<button id="sel-menu-copy"></button><button id="sel-menu-all"></button></div></div>' +
      '<div id="scroll-indicator"><div id="scroll-thumb"></div></div>'
    const posted: Record<string, unknown>[] = []
    const scope = probeScope({
      installHostTransport: () => () => {},
      hasEngine: () => true,
      postToHost: (message) => posted.push(message),
      viewportRect: () => ({ left: 0, top: 0, width: 427, height: 800 })
    })
    startTerminalDocument(scope)
    try {
      expect(posted).toEqual([
        {
          type: 'web-ready',
          cellMetrics: TERMINAL_TEXT_SCALES.map((scale) => expectedCell(scale, true)),
          viewportWidth: 427,
          viewportHeight: 800
        }
      ])
    } finally {
      stopTerminalDocument(scope)
    }
  })
})

describe('the laid-out box, from a started document', () => {
  /** A document over a 55x47 grid whose renderer the case controls, and every notify it posts. */
  function startedOverRenderer() {
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    const cell = { width: 23 / 3, height: 15 }
    const renderListeners: (() => void)[] = []
    const terminal = Object.assign(terminalDocumentDouble().terminal, {
      cols: 55,
      rows: 47,
      _core: {
        _renderService: {
          get dimensions() {
            return { css: { cell: { ...cell } } }
          }
        }
      },
      onRender: (listener: () => void) => {
        renderListeners.push(listener)
        return { dispose() {} }
      }
    })
    const posted: Record<string, unknown>[] = []
    const scope = probeScope({
      installHostTransport: () => () => {},
      hasEngine: () => true,
      createTerminal: () => terminal,
      postToHost: (message) => posted.push(message)
    })
    startTerminalDocument(scope)
    handleMsg(scope, { type: 'init', cols: 55, rows: 47, initialData: '', preserveScroll: false })
    const render = () => renderListeners.forEach((listener) => listener())
    return { scope, cell, posted, render }
  }

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  async function untilReady(posted: Record<string, unknown>[]) {
    for (let frame = 0; frame < 30 && !posted.some((m) => m.type === 'ready'); frame++) {
      await nextFrame()
    }
  }
  const boxes = (posted: Record<string, unknown>[]) =>
    posted.filter((m) => m.type === 'cell-metrics').map((m) => m.cellMetrics)

  it('reports a paused renderer at ready, before ready itself', async () => {
    const { scope, posted } = startedOverRenderer()
    try {
      await untilReady(posted)
      const types = posted.map((m) => m.type)
      expect(types.indexOf('cell-metrics')).toBeGreaterThan(-1)
      expect(types.indexOf('cell-metrics')).toBeLessThan(types.indexOf('ready'))
      expect(boxes(posted)).toEqual([[{ fontScale: 1, cellWidth: 23 / 3, cellHeight: 15 }]])
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('reports a renderer swap after context loss on the next render', async () => {
    const { scope, cell, posted, render } = startedOverRenderer()
    try {
      await untilReady(posted)
      cell.width = 7.8
      render()
      expect(boxes(posted).at(-1)).toEqual([{ fontScale: 1, cellWidth: 7.8, cellHeight: 15 }])
    } finally {
      stopTerminalDocument(scope)
    }
  })
})
