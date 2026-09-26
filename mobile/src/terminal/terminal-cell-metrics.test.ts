import { describe, expect, it } from 'vitest'
import {
  createTerminalCellMetricsStore,
  fitDimensionsFromCell,
  readTerminalCellMetrics
} from './terminal-cell-metrics'

// 23 and 51 device px at DPR 3: the WebGL renderer's 13px cell on the emulator.
const CELL_1X = { fontScale: 1, cellWidth: 23 / 3, cellHeight: 17 }
const CELL_125X = { fontScale: 1.25, cellWidth: 29 / 3, cellHeight: 21 }

function webReady(extra: Record<string, unknown> = {}) {
  return {
    type: 'web-ready',
    cellMetrics: [CELL_1X, CELL_125X],
    viewportWidth: 427,
    viewportHeight: 800,
    ...extra
  }
}

describe('readTerminalCellMetrics', () => {
  it('reads nothing from an older document that sends no cell box', () => {
    expect(readTerminalCellMetrics({ type: 'web-ready' })).toEqual([])
  })

  it('drops malformed entries and keeps the well-formed ones', () => {
    expect(
      readTerminalCellMetrics({
        cellMetrics: [null, { fontScale: 1, cellWidth: 0, cellHeight: 17 }, 'x', CELL_1X]
      })
    ).toEqual([CELL_1X])
  })
})

describe('createTerminalCellMetricsStore', () => {
  it('answers from the web-ready table and viewport, as the document measure would', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady())
    // floor(427 / 7.667) = 55, floor(751 / 17) = 44
    expect(store.fit(1, 751)).toEqual({ cols: 55, rows: 44 })
    // No container height: the document's own viewport height, like its measure's fallback.
    expect(store.fit(1)).toEqual({ cols: 55, rows: 47 })
  })

  it('answers a text-scale change from that scale entry', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady())
    expect(store.fit(1.25, 751)).toEqual({ cols: 44, rows: 35 })
  })

  it('is unknown without a table, for an unreported scale, or before any box', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady({ type: 'web-ready' })
    expect(store.fit(1, 751)).toBeUndefined()
    store.acceptWebReady(webReady())
    expect(store.fit(1.5, 751)).toBeUndefined()
    store.acceptWebReady(webReady({ viewportWidth: 0 }))
    expect(store.fit(1, 751)).toBeUndefined()
  })

  it('follows the view layout, and keeps it across a reloaded document', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady())
    store.layout(854, 400)
    expect(store.fit(1)).toEqual({ cols: 111, rows: 23 })
    store.clear()
    store.acceptWebReady(webReady())
    expect(store.fit(1)).toEqual({ cols: 111, rows: 23 })
  })

  it('answers null for a box too narrow to fit, like the document', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady({ viewportWidth: 100 }))
    expect(store.fit(1, 751)).toBeNull()
  })

  it('takes the box xterm laid out over the probe, and says when it corrected a guess', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady())
    const actual = { fontScale: 1, cellWidth: 7.8, cellHeight: 17 }
    expect(store.acceptLaidOut({ type: 'cell-metrics', cellMetrics: [actual] })).toEqual(actual)
    expect(store.fit(1, 751)).toEqual({ cols: 54, rows: 44 })
    // The same box again, or one that matches the guess, corrected nothing.
    expect(store.acceptLaidOut({ type: 'cell-metrics', cellMetrics: [actual] })).toBeNull()
    expect(store.acceptLaidOut({ type: 'cell-metrics', cellMetrics: [CELL_125X] })).toBeNull()
    expect(store.acceptLaidOut({ type: 'cell-metrics' })).toBeNull()
  })

  it('corrects a guess once; later col-dependent boxes update the fit without another correction', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady())
    const laidOut = (cellWidth: number) =>
      store.acceptLaidOut({
        type: 'cell-metrics',
        cellMetrics: [{ fontScale: 1, cellWidth, cellHeight: 17 }]
      })
    expect(laidOut(7.8)).not.toBeNull()
    // The DOM renderer re-derives the width from the new column count after each re-init.
    expect(laidOut(8.4)).toBeNull()
    expect(store.fit(1, 751)).toEqual({ cols: 50, rows: 44 })
    expect(laidOut(8.3)).toBeNull()
    expect(store.fit(1, 751)).toEqual({ cols: 51, rows: 44 })
  })

  it('does not call a first box a correction when there was no guess', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady({ type: 'web-ready' })
    expect(store.acceptLaidOut({ type: 'cell-metrics', cellMetrics: [CELL_1X] })).toBeNull()
  })

  it('forgets a replaced document', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady())
    store.clear()
    expect(store.fit(1, 751)).toBeUndefined()
  })
})

describe('fitDimensionsFromCell', () => {
  it('does not lose a column or row to floating-point error at an exact boundary', () => {
    // 0.1 + 0.2 is 0.30000000000000004, so 6 / it is 19.999999999999996.
    const cell = { cellWidth: 0.1 + 0.2, cellHeight: 0.1 + 0.2 }
    expect(fitDimensionsFromCell(cell, 6, 3)).toEqual({ cols: 20, rows: 10 })
  })
})
