// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { laidOutCellBox, reportLaidOutCellBox } from './laid-out-cell-box'
import { createTerminalDocumentScope, type TerminalDocumentScope } from './document-scope'
import { startTerminalDocument, stopTerminalDocument } from './create-terminal-document'
import type { TerminalDocumentHost } from './document-host-seams'
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

  it('reads the box xterm laid out at the current text scale, with its grid', () => {
    const scope = scopeWithCell({ width: 29 / 3, height: 21 }, 16)
    expect(laidOutCellBox(scope)).toEqual({
      cellBox: { fontScale: 1.25, cellWidth: 29 / 3, cellHeight: 21 },
      cols: 55,
      rows: 47
    })
  })

  it('tells the host each new box once, and refits only a box that changed at a kept grid', () => {
    const posted: Record<string, unknown>[] = []
    const cell = { width: 29 / 3, height: 21 }
    const scope = scopeWithCell(cell, 16, posted)
    reportLaidOutCellBox(scope)
    reportLaidOutCellBox(scope)
    Object.assign(scope.term!, { cols: 50 })
    reportLaidOutCellBox(scope)
    cell.width = 9.75
    reportLaidOutCellBox(scope)
    expect(posted).toEqual([
      {
        type: 'cell-box',
        cellBox: { fontScale: 1.25, cellWidth: 29 / 3, cellHeight: 21 },
        refit: false
      },
      {
        type: 'cell-box',
        cellBox: { fontScale: 1.25, cellWidth: 9.75, cellHeight: 21 },
        refit: true
      }
    ])
  })
})

describe('a started document', () => {
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
    posted.filter((m) => m.type === 'cell-box').map((m) => m.cellBox)
  const refits = (posted: Record<string, unknown>[]) =>
    posted.filter((m) => m.type === 'cell-box').map((m) => m.refit)
  const reflowTo = (scope: TerminalDocumentScope, cols: number) =>
    handleMsg(scope, { type: 'reflow', cols, rows: 47 })

  it('takes the frame the app laid out from init, resize and reflow', () => {
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
      handleMsg(scope, { type: 'resize', cols: 54, rows: 47, frame: { width: 420, height: 700 } })
      expect(scope.hostFrame).toEqual({ width: 420, height: 700 })
      handleMsg(scope, { type: 'reflow', cols: 53, rows: 46, frame: { width: 410, height: 690 } })
      expect(scope.hostFrame).toEqual({ width: 410, height: 690 })
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('reports ready with the box its own terminal laid out, at the app text scale', () => {
    const { scope, posted, built } = started({ start: () => ({ textScale: 1.25, shown: true }) })
    try {
      expect(built).toHaveLength(1)
      expect(built[0].options.fontSize).toBe(16)
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
      expect(posted.filter((message) => message.type === 'cell-box')).toEqual([])
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('reports a paused renderer at ready, before ready itself', async () => {
    const { scope, cell, posted, init } = started()
    try {
      cell.width = 7.8
      init()
      await untilReady(posted)
      const types = posted.map((m) => m.type)
      expect(types.indexOf('cell-box')).toBeGreaterThan(-1)
      expect(types.indexOf('cell-box')).toBeLessThan(types.indexOf('ready'))
      expect(boxes(posted)).toEqual([{ fontScale: 1, cellWidth: 7.8, cellHeight: 15 }])
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('reports a text-size change on the render after it, not when the font is set', async () => {
    // Font-size changes update xterm metrics synchronously; onRender observes the new box only after repaint.
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

  it('reports a changed cell width on the next render', async () => {
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

  it("refits a DOM first init once, and not again on the refit's own report", async () => {
    const { scope, cell, posted, render, init } = started()
    try {
      cell.width = 7.8
      init()
      await untilReady(posted)
      expect(refits(posted)).toEqual([true])
      cell.width = 7.9
      reflowTo(scope, 54)
      render()
      expect(refits(posted)).toEqual([true, false])
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('never refits a box that came with a new grid, so the DOM renderer cannot loop', async () => {
    const { scope, cell, posted, render, init } = started()
    try {
      init()
      await untilReady(posted)
      for (const [cols, width] of [
        [50, 7.9],
        [55, 7.8],
        [54, 8]
      ]) {
        cell.width = width
        reflowTo(scope, cols)
        render()
      }
      expect(refits(posted)).toEqual([false, false, false])
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('refits a renderer swap at a grid applied in place', async () => {
    const { scope, cell, posted, render, init } = started()
    try {
      init()
      await untilReady(posted)
      reflowTo(scope, 50)
      render()
      expect(refits(posted)).toEqual([])
      cell.width = 7.8
      render()
      expect(refits(posted)).toEqual([true])
    } finally {
      stopTerminalDocument(scope)
    }
  })

  it('refits a re-init at the same grid with a different renderer', async () => {
    const { scope, cell, posted, init } = started()
    try {
      init()
      await untilReady(posted)
      posted.length = 0
      cell.width = 7.8
      init()
      await untilReady(posted)
      expect(refits(posted)).toEqual([true])
    } finally {
      stopTerminalDocument(scope)
    }
  })
})
