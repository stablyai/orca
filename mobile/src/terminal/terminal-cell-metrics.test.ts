import { describe, expect, it } from 'vitest'
import { createTerminalCellMetricsStore, readTerminalCellMetrics } from './terminal-cell-metrics'

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

  it('follows the view layout after the document report', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady())
    store.layout(854, 400)
    expect(store.fit(1)).toEqual({ cols: 111, rows: 23 })
  })

  it('answers null for a box too narrow to fit, like the document', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady({ viewportWidth: 100 }))
    expect(store.fit(1, 751)).toBeNull()
  })

  it('takes the box xterm laid out at ready over the probe', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady())
    const actual = { fontScale: 1, cellWidth: 7.8, cellHeight: 17 }
    expect(store.acceptReady({ type: 'ready', cellMetrics: [actual] })).toEqual({
      reported: CELL_1X,
      actual
    })
    expect(store.fit(1, 751)).toEqual({ cols: 54, rows: 44 })
    expect(store.acceptReady({ type: 'ready' })).toBeNull()
  })

  it('forgets a replaced document', () => {
    const store = createTerminalCellMetricsStore()
    store.acceptWebReady(webReady())
    store.clear()
    expect(store.fit(1, 751)).toBeUndefined()
  })
})
