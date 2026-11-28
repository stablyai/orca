import { describe, expect, it } from 'vitest'
import { TerminalPublishedOutputRing } from './terminal-published-output-ring'

describe('TerminalPublishedOutputRing', () => {
  it('bounds retained empty transformed chunks and advances coverage past evicted entries', () => {
    const size = { cols: 80, rows: 24 }
    const ring = new TerminalPublishedOutputRing(0, () => size)
    const totalChunks = 2100

    for (let i = 1; i <= totalChunks; i += 1) {
      ring.append({
        data: '',
        seq: i * 10,
        rawLength: 10,
        transformed: true
      })
    }

    const evictedPoint = ring.pointAt(10)
    expect(ring.covers(evictedPoint)).toBe(false)
    expect(ring.readAfter(evictedPoint, totalChunks * 10)).toBeNull()

    const retainedPoint = ring.pointAt((totalChunks - 5) * 10)
    expect(ring.covers(retainedPoint)).toBe(true)
    const gap = ring.readAfter(retainedPoint, totalChunks * 10)
    expect(gap).toHaveLength(5)
    expect(gap?.[0]?.seq).toBe((totalChunks - 4) * 10)
    expect(gap?.[4]?.seq).toBe(totalChunks * 10)
  })

  it('retains a single full-budget chunk without evicting it under the chunk cap', () => {
    const size = { cols: 80, rows: 24 }
    const ring = new TerminalPublishedOutputRing(0, () => size)
    const startPoint = ring.pointAt(0)
    const payload = 'x'.repeat(64 * 1024)

    ring.append({
      data: payload,
      seq: payload.length,
      rawLength: payload.length,
      transformed: false
    })

    expect(ring.covers(startPoint)).toBe(true)
    const gap = ring.readAfter(startPoint, payload.length)
    expect(gap).toHaveLength(1)
    expect(gap?.[0]?.data.length).toBe(64 * 1024)
  })
})
