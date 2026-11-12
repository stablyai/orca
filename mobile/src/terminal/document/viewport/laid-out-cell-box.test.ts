// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportLaidOutCellBox } from './laid-out-cell-box'
import { createTerminalDocumentScope } from '../document-scope'
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
