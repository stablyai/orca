import { describe, expect, it } from 'vitest'
import { createTerminalLiveOscLinkTracker } from './terminal-live-osc-link-ranges'

describe('terminal live OSC link tracker', () => {
  it('retains a bounded same-row OSC-8 range', () => {
    const tracker = createTerminalLiveOscLinkTracker()

    expect(
      tracker.handle(';https://example.com/issue/1', { row: 4, column: 6, columns: 80 })
    ).toEqual([])
    expect(tracker.handle(';', { row: 4, column: 12, columns: 80 })).toEqual([
      {
        row: 4,
        startCol: 6,
        endCol: 12,
        uri: 'https://example.com/issue/1'
      }
    ])
  })

  it('splits a wrapped OSC-8 range across terminal rows', () => {
    const tracker = createTerminalLiveOscLinkTracker()

    tracker.handle('id=task;file:///tmp/result.txt', { row: 2, column: 70, columns: 80 })

    expect(tracker.handle(';', { row: 4, column: 5, columns: 80 })).toEqual([
      { row: 2, startCol: 70, endCol: 80, uri: 'file:///tmp/result.txt' },
      { row: 3, startCol: 0, endCol: 80, uri: 'file:///tmp/result.txt' },
      { row: 4, startCol: 0, endCol: 5, uri: 'file:///tmp/result.txt' }
    ])
  })

  it('shifts an open link when the leading scrollback row is evicted', () => {
    const tracker = createTerminalLiveOscLinkTracker()

    tracker.handle(';https://example.com', { row: 2, column: 3, columns: 80 })
    tracker.trimLeadingRow()

    expect(tracker.handle(';', { row: 1, column: 8, columns: 80 })).toEqual([
      { row: 1, startCol: 3, endCol: 8, uri: 'https://example.com' }
    ])
  })

  it('drops malformed, oversized, stale, and reset links', () => {
    const tracker = createTerminalLiveOscLinkTracker()
    const cursor = { row: 0, column: 0, columns: 80 }

    expect(tracker.handle(`;${'x'.repeat(2_049)}`, cursor)).toEqual([])
    expect(tracker.handle(';', { ...cursor, column: 5 })).toEqual([])
    tracker.handle(';https://example.com', cursor)
    expect(tracker.handle('missing-separator', { ...cursor, column: 5 })).toEqual([])
    tracker.handle(';https://example.com', cursor)
    tracker.reset()
    expect(tracker.handle(';', { ...cursor, column: 5 })).toEqual([])
  })
})
