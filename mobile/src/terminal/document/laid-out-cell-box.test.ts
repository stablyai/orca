// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { laidOutCellBox, reportLaidOutCellBox } from './laid-out-cell-box'
import { createTerminalDocumentScope } from './document-scope'
import { startTerminalDocument, stopTerminalDocument } from './create-terminal-document'
import type { TerminalDocumentHost } from './document-host-seams'
import { fontPxForScale } from './text-scaling'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { handleMsg } from './host-message-router'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html/document-markup'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('laidOutCellBox', () => {
  function scopeWithCell(
    cell: { width: number; height: number },
    fontSize: number,
    posted: Record<string, unknown>[] = []
  ) {
    const scope = createTerminalDocumentScope({ postToHost: (message) => posted.push(message) })
    scope.currentTextScale = 1.25
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader touches only cols, rows, options.fontSize and _core's render dimensions.
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
    expect(laidOutCellBox(scope)).toEqual({ fontScale: 1.25, cellWidth: 29 / 3, cellHeight: 21 })
  })

  it('tells the host each new laid-out box once, with the grid it belongs to', () => {
    const posted: Record<string, unknown>[] = []
    const cell = { width: 29 / 3, height: 21 }
    const scope = scopeWithCell(cell, fontPxForScale(1.25), posted)
    reportLaidOutCellBox(scope)
    reportLaidOutCellBox(scope)
    cell.width = 9.75
    reportLaidOutCellBox(scope)
    expect(posted).toEqual([
      {
        type: 'cell-metrics',
        cellBox: { fontScale: 1.25, cellWidth: 29 / 3, cellHeight: 21 },
        cols: 55,
        rows: 47
      },
      {
        type: 'cell-metrics',
        cellBox: { fontScale: 1.25, cellWidth: 9.75, cellHeight: 21 },
        cols: 55,
        rows: 47
      }
    ])
  })

  it('tells the host a new grid even when the box stayed, so the host holds the grid it has', () => {
    const posted: Record<string, unknown>[] = []
    const scope = scopeWithCell({ width: 29 / 3, height: 21 }, fontPxForScale(1.25), posted)
    reportLaidOutCellBox(scope)
    Object.assign(scope.term!, { cols: 50 })
    reportLaidOutCellBox(scope)
    expect(posted.map((message) => message.cols)).toEqual([55, 50])
  })
})

describe('a started document', () => {
  /** A document whose engine builds grids with a cell that follows the font, and every notify. */
  function started(host: TerminalDocumentHost = {}) {
    document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
    const cell = { width: 23 / 3, height: 15 }
    const renderListeners: (() => void)[] = []
    const built: { options: Record<string, unknown> }[] = []
    const createTerminal = (options: Record<string, unknown>) => {
      const terminal = terminalDocumentDouble().terminal
      const grid = Object.assign(terminal, {
        cols: Number(options.cols),
        rows: Number(options.rows),
        options: { ...terminal.options, fontSize: Number(options.fontSize) },
        _core: {
          _renderService: {
            get dimensions() {
              const k = grid.options.fontSize / 13
              return { css: { cell: { width: cell.width * k, height: cell.height * k } } }
            }
          }
        },
        onRender: (listener: () => void) => {
          renderListeners.push(listener)
          return { dispose() {} }
        }
      })
      grid.resize = (cols: number, rows: number) => {
        grid.cols = cols
        grid.rows = rows
      }
      built.push({ options })
      return grid
    }
    const posted: Record<string, unknown>[] = []
    const scope = createTerminalDocumentScope({
      installHostTransport: () => () => {},
      hasEngine: () => true,
      createTerminal,
      postToHost: (message) => posted.push(message),
      ...host
    })
    startTerminalDocument(scope)
    const render = () => renderListeners.forEach((listener) => listener())
    const init = () =>
      handleMsg(scope, { type: 'init', cols: 55, rows: 47, initialData: '', preserveScroll: false })
    return { scope, cell, posted, render, built, init }
  }

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  async function untilReady(posted: Record<string, unknown>[]) {
    for (let frame = 0; frame < 30 && !posted.some((m) => m.type === 'ready'); frame++) {
      await nextFrame()
    }
  }
  const boxes = (posted: Record<string, unknown>[]) =>
    posted.filter((m) => m.type === 'cell-metrics').map((m) => m.cellBox)

  it('takes the frame the app laid out from init, as from a measure', () => {
    const { scope } = started()
    try {
      handleMsg(scope, {
        type: 'init',
        cols: 55,
        rows: 47,
        initialData: '',
        preserveScroll: false,
        frame: { width: 427.5, height: 710 }
      })
      expect(scope.hostFrame).toEqual({ width: 427.5, height: 710 })
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('reports ready with the box its own terminal laid out, at the app text scale', () => {
    const { scope, posted, built } = started({ start: () => ({ textScale: 1.25, shown: true }) })
    try {
      expect(built).toHaveLength(1)
      expect(built[0].options.fontSize).toBe(fontPxForScale(1.25))
      expect(posted[0]).toEqual({
        type: 'web-ready',
        cellBox: { fontScale: 1.25, cellWidth: (23 / 3) * (16 / 13), cellHeight: 15 * (16 / 13) }
      })
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('leaves no live terminal when opening the one it builds before ready throws', () => {
    const double = terminalDocumentDouble()
    double.terminal.open = () => {
      throw new Error('no surface')
    }
    const { scope, posted } = started({ createTerminal: () => double.terminal })
    try {
      expect(scope.term).toBeNull()
      expect(double.disposals()).toBe(1)
      expect(posted[0]).toEqual({ type: 'web-ready', cellBox: null })
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('builds nothing before ready for a view hidden when it mounted, and reports no box', () => {
    const { scope, posted, built } = started({ start: () => ({ textScale: 1, shown: false }) })
    try {
      expect(built).toHaveLength(0)
      expect(posted[0]).toEqual({ type: 'web-ready', cellBox: null })
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('reuses that terminal for the first init, so an open builds one xterm', async () => {
    const { scope, posted, built, init } = started()
    try {
      const prepared = scope.term
      init()
      await untilReady(posted)
      expect(built).toHaveLength(1)
      expect(scope.term).toBe(prepared)
      expect(scope.term?.cols).toBe(55)
      expect(scope.term?.rows).toBe(47)
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('keeps the terminal built before ready out of sight until the first init has replayed', async () => {
    const { scope, posted, init } = started()
    try {
      // Hidden, not removed from layout: the box is measured and reported while it is out of sight.
      expect(scope.surface?.style.visibility).toBe('hidden')
      expect(scope.surface?.style.display).toBe('')
      expect(posted[0]).toEqual({
        type: 'web-ready',
        cellBox: { fontScale: 1, cellWidth: 23 / 3, cellHeight: 15 }
      })
      init()
      expect(scope.surface?.style.visibility).toBe('hidden')
      await untilReady(posted)
      expect(scope.surface?.style.visibility).toBe('')
      expect(posted.filter((message) => message.type === 'cell-metrics')).toHaveLength(1)
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('reports a paused renderer at ready, before ready itself', async () => {
    const { scope, posted, init } = started()
    try {
      init()
      await untilReady(posted)
      const types = posted.map((m) => m.type)
      expect(types.indexOf('cell-metrics')).toBeGreaterThan(-1)
      expect(types.indexOf('cell-metrics')).toBeLessThan(types.indexOf('ready'))
      expect(boxes(posted)).toEqual([{ fontScale: 1, cellWidth: 23 / 3, cellHeight: 15 }])
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('reports a text-size change on the render after it, not when the font is set', async () => {
    // xterm updates the render service's cell box synchronously when fontSize is set
    // (CharSizeService.measure → RenderService.handleCharSizeChanged), and onRender fires after the
    // rows it redrew, so the next render reads the new box at the new scale.
    const { scope, posted, render, init } = started()
    try {
      init()
      await untilReady(posted)
      const reported = boxes(posted).length
      handleMsg(scope, { type: 'set-font-scale', fontScale: 1.25 })
      expect(boxes(posted)).toHaveLength(reported)
      render()
      expect(boxes(posted).at(-1)).toEqual({
        fontScale: 1.25,
        cellWidth: (23 / 3) * (16 / 13),
        cellHeight: 15 * (16 / 13)
      })
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('reports a renderer swap after context loss on the next render', async () => {
    const { scope, cell, posted, render, init } = started()
    try {
      init()
      await untilReady(posted)
      cell.width = 7.8
      render()
      expect(boxes(posted).at(-1)).toEqual({ fontScale: 1, cellWidth: 7.8, cellHeight: 15 })
    } finally {
      stopTerminalDocument(scope)
    }
  })
})
