// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startTerminalDocument, stopTerminalDocument } from './create-terminal-document'
import { createTerminalDocumentScope, type TerminalDocumentScope } from './document-scope'
import type { TerminalDocumentHost, TerminalViewportChange } from './document-host-seams'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { handleMsg } from './host-message-router'
import { viewportToMouseReportCell } from './mouse-report-cell'
import { handleDragMove } from './selection-overlay'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html/document-markup'
import { viewportToCell } from './viewport-cell'
import { computeFitScale } from './viewport-transform'

const HEADER = 82
const CELL = { width: 7.5, height: 15 }

function scopeWithGrid(host: TerminalDocumentHost = {}): TerminalDocumentScope {
  const scope = createTerminalDocumentScope(host)
  const terminal = terminalDocumentDouble().terminal
  const cell = () => {
    const k = terminal.options.fontSize / 13
    return { width: CELL.width * k, height: CELL.height * k }
  }
  const grid = Object.assign(terminal, {
    cols: 55,
    rows: 40,
    _core: {
      _renderService: {
        get dimensions() {
          return { css: { cell: cell() } }
        }
      }
    }
  })
  grid.resize = (cols: number, rows: number) => {
    grid.cols = cols
    grid.rows = rows
  }
  scope.term = grid
  return scope
}

const started: TerminalDocumentScope[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  while (started.length > 0) {
    stopTerminalDocument(started.pop()!)
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function startedWithGrid(host: TerminalDocumentHost): TerminalDocumentScope {
  document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
  const grid = scopeWithGrid().term!
  const scope = createTerminalDocumentScope({
    installHostTransport: () => () => {},
    hasEngine: () => true,
    createTerminal: () => grid,
    ...host
  })
  startTerminalDocument(scope)
  started.push(scope)
  handleMsg(scope, { type: 'init', cols: 55, rows: 40, initialData: '', preserveScroll: false })
  return scope
}

const nextFrame = () => vi.advanceTimersToNextFrame()

async function framesUntil(done: () => boolean, { required = true } = {}) {
  for (let frame = 0; frame < 30 && !done(); frame++) {
    await nextFrame()
  }
  if (required) {
    expect(done()).toBe(true)
  }
}

const FIT_390 = 390 / (7.5 * 55)

const pageHost = (): TerminalDocumentHost => ({
  viewportRect: () => ({ left: 0, top: HEADER, width: 412, height: 600 })
})

describe("the document's frame on the page", () => {
  it('maps a tap below a header to the cell the WebView reports for the same spot', () => {
    const native = viewportToCell(scopeWithGrid(), 30, 150)
    const page = viewportToCell(scopeWithGrid(pageHost()), 30, 150 + HEADER)
    expect(native).toEqual({ col: 4, row: 10 })
    expect(page).toEqual(native)
  })

  it('reports a mouse cell below a header as the WebView does', () => {
    const native = viewportToMouseReportCell(scopeWithGrid(), 30, 150)
    const page = viewportToMouseReportCell(scopeWithGrid(pageHost()), 30, 150 + HEADER)
    expect(native).toMatchObject({ col: 4, row: 10 })
    expect(page).toEqual(native)
  })

  it('keeps the fit at 1 while the host is hidden and measures 0x0', () => {
    // Inactive react-native-screens routes use display:none and have no measurable host box.
    const scope = scopeWithGrid({
      viewportRect: () => ({ left: 0, top: 0, width: 0, height: 0 })
    })
    expect(computeFitScale(scope)).toBe(1)
  })

  it('commits no fit before the host has a box, and one once it has', async () => {
    // Initial hidden mounts wait for real RN layout; subsequent hide/show is handled by the mount adapter.
    let box = { left: 0, top: 0, width: 0, height: 0 }
    const widthsRead: number[] = []
    const changes: ((change: TerminalViewportChange) => void)[] = []
    const scope = startedWithGrid({
      viewportRect: () => {
        widthsRead.push(box.width)
        return box
      },
      observeViewport: (onChange) => {
        changes.push(onChange)
        return () => {}
      }
    })
    const scales: string[] = []
    const style = scope.surface!.style
    const write = style.setProperty
    vi.spyOn(style, 'setProperty').mockImplementation((name, value, priority) => {
      if (name === 'transform') {
        const transform = String(value)
        scales.push(/scale\(([^)]*)\)/.exec(transform)?.[1] ?? transform)
      }
      write.call(style, name, value, priority)
    })
    await framesUntil(() => widthsRead.includes(0))
    await nextFrame()
    expect(scales).toEqual([])
    box = { left: 0, top: 0, width: 390, height: 600 }
    changes.forEach((onChange) => onChange('resized'))
    await framesUntil(() => scales.length === 2)
    expect(scales).toEqual(['1', String(FIT_390)])
  })

  it("edge-scrolls at the host's own edges, not the window's", () => {
    const scope = startedWithGrid({
      viewportRect: () => ({ left: 0, top: 100, width: 412, height: 600 })
    })
    scope.selMode = 'select'
    scope.sel = { anchor: { col: 0, row: 5 }, focus: { col: 3, row: 5 }, activeHandle: 'end' }
    const edge = (clientY: number) => {
      handleDragMove(scope, 'end', 30, clientY)
      return scope.edgeScrollDir
    }
    expect(edge(580)).toBe(0)
    expect(edge(680)).toBe(1)
    expect(edge(400)).toBe(0)
    expect(edge(120)).toBe(-1)
  })
})
