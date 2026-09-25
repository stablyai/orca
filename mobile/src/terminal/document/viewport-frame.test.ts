// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { startTerminalDocument, stopTerminalDocument } from './create-terminal-document'
import { createTerminalDocumentScope, type TerminalDocumentScope } from './document-scope'
import type { TerminalDocumentHost } from './document-host-seams'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { handleMsg } from './host-message-router'
import { viewportToMouseReportCell } from './mouse-report-cell'
import { handleDragMove } from './selection-overlay'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal-webview-html/document-markup'
import { viewportToCell } from './viewport-cell'
import { computeFitScale } from './viewport-transform'

/** The session header above the page's terminal, in CSS px; the WebView has none above it. */
const HEADER = 82
const CELL = { width: 7.5, height: 15 }

/** A scope with a laid-out 55x40 grid, hosted however the case says. */
function scopeWithGrid(host: TerminalDocumentHost = {}): TerminalDocumentScope {
  const scope = createTerminalDocumentScope(host)
  scope.term = Object.assign(terminalDocumentDouble().terminal, {
    cols: 55,
    rows: 40,
    _core: { _renderService: { dimensions: { css: { cell: CELL } } } }
  })
  return scope
}

const started: TerminalDocumentScope[] = []

afterEach(() => {
  while (started.length > 0) {
    stopTerminalDocument(started.pop()!)
  }
})

/** A started document over a grid, with the page's seams the case names. */
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

const frames = () => new Promise((resolve) => setTimeout(resolve, 100))

const pageHost = (): TerminalDocumentHost => ({
  viewportRect: () => ({ left: 0, top: HEADER, width: 412, height: 600 })
})

describe("the document's frame on the page", () => {
  it('maps a tap below a header to the cell the WebView reports for the same spot', () => {
    // Row 10, column 4 of the grid: at (30, 150) in the WebView, and HEADER lower on the page.
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
    // react-native-screens hides an inactive screen with display:none, so its host has no box.
    const scope = scopeWithGrid({
      viewportRect: () => ({ left: 0, top: 0, width: 0, height: 0 })
    })
    expect(computeFitScale(scope)).toBe(1)
  })

  it('commits no fit while the host is hidden, and one once it has a box', async () => {
    let box = { left: 0, top: 0, width: 0, height: 0 }
    const changes: (() => void)[] = []
    const scope = startedWithGrid({
      viewportRect: () => box,
      observeViewport: (onChange) => {
        changes.push(onChange)
        return () => {}
      }
    })
    const scales: string[] = []
    const style = scope.surface!.style
    Object.defineProperty(style, 'transform', {
      set: (value: string) => scales.push(/scale\(([^)]*)\)/.exec(value)?.[1] ?? value),
      get: () => ''
    })
    await frames()
    expect(scales).toEqual([])
    box = { left: 0, top: 0, width: 390, height: 600 }
    changes.forEach((onChange) => onChange())
    await frames()
    // The refit repaints at the scale it has, then the fit commits once: 390 / (7.5 x 55).
    expect(scales).toEqual(['1', String(390 / (7.5 * 55))])
  })

  it("edge-scrolls at the host's own edges, not the window's", () => {
    // Host top 100, height 600: its bottom edge band is 660-700 in client Y, not 560-600.
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

  it('keeps pan and zoom while a hidden host reports 0x0, and refits once it has a box', async () => {
    // react-native-screens hides the session when another screen covers it; coming back must
    // find the pan the user left, as native does, since native never refits on navigation.
    let box = { left: 0, top: 0, width: 390, height: 600 }
    const changes: (() => void)[] = []
    const scope = startedWithGrid({
      viewportRect: () => box,
      observeViewport: (onChange) => {
        changes.push(onChange)
        return () => {}
      }
    })
    await frames()
    scope.panX = -40
    scope.panY = -30
    scope.userScale = 1.5
    const kept = { panX: -40, panY: -30, userScale: 1.5, currentScale: scope.currentScale }
    box = { left: 0, top: 0, width: 0, height: 0 }
    changes.forEach((onChange) => onChange())
    await frames()
    const { panX, panY, userScale, currentScale } = scope
    expect({ panX, panY, userScale, currentScale }).toEqual(kept)

    box = { left: 0, top: 0, width: 390, height: 600 }
    const scales: string[] = []
    Object.defineProperty(scope.surface!.style, 'transform', {
      set: (value: string) => scales.push(/scale\(([^)]*)\)/.exec(value)?.[1] ?? value),
      get: () => ''
    })
    changes.forEach((onChange) => onChange())
    await frames()
    expect(scope.userScale).toBe(1)
    expect(scales.at(-1)).toBe(String(390 / (7.5 * 55)))
  })
})
