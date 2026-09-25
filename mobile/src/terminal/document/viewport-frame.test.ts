// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createTerminalDocumentScope, type TerminalDocumentScope } from './document-scope'
import type { TerminalDocumentHost } from './document-host-seams'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { viewportToMouseReportCell } from './mouse-report-cell'
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
})
