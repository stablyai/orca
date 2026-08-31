import { describe, expect, it } from 'vitest'
import { PtySourceSentBoundaries } from './pty-source-sent-boundaries'

describe('PtySourceSentBoundaries', () => {
  it('keeps the checkpoint boundary and every later insert', () => {
    const boundaries = new PtySourceSentBoundaries(4)
    boundaries.add(9)
    boundaries.add(11)
    expect([...boundaries]).toEqual([4, 9, 11])
    expect(boundaries.has(4)).toBe(true)
    expect(boundaries.has(9)).toBe(true)
    expect(boundaries.has(11)).toBe(true)
    expect(boundaries.has(10)).toBe(false)
    expect(boundaries.has(12)).toBe(false)
  })

  it('rejects a boundary that does not ascend past the highest insert', () => {
    const boundaries = new PtySourceSentBoundaries(4)
    boundaries.add(9)
    expect(() => boundaries.add(9)).toThrow('does not ascend')
    expect(() => boundaries.add(5)).toThrow('does not ascend')
    expect([...boundaries]).toEqual([4, 9])
  })

  it('drops every boundary below the credit and keeps the credit itself', () => {
    const boundaries = new PtySourceSentBoundaries(0)
    for (const boundary of [1, 2, 3, 4, 5]) {
      boundaries.add(boundary)
    }
    boundaries.dropBelow(3)
    expect([...boundaries]).toEqual([3, 4, 5])
    expect(boundaries.has(2)).toBe(false)
    expect(boundaries.has(3)).toBe(true)
  })

  it('stays correct across the compaction that follows a long interleaved drain', () => {
    const boundaries = new PtySourceSentBoundaries(0)
    for (let boundary = 1; boundary <= 4_096; boundary += 1) {
      boundaries.add(boundary)
      boundaries.dropBelow(boundary - 1)
      expect(boundaries.has(boundary - 1)).toBe(true)
      expect(boundaries.has(boundary - 2)).toBe(false)
    }
    expect([...boundaries]).toEqual([4_095, 4_096])
  })
})
