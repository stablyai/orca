// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createTerminalDocumentScope, type TerminalDocumentScope } from '../document-scope'
import type { TerminalDocumentHost } from '../document-host-seams'
import { terminalDocumentDouble } from '../document-terminal-double.test-support'
import { computeFitScale } from './viewport-transform'

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

describe("the document's frame on the page", () => {
  it('keeps the fit at 1 while the host is hidden and measures 0x0', () => {
    // Inactive react-native-screens routes use display:none and have no measurable host box.
    const scope = scopeWithGrid({
      viewportRect: () => ({ left: 0, top: 0, width: 0, height: 0 })
    })
    expect(computeFitScale(scope)).toBe(1)
  })
})
