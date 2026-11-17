import { describe, expect, it } from 'vitest'
import { describeWorkerMessage } from './worker-message-shape'

describe('describeWorkerMessage', () => {
  it('names a reply and counts its rows and text', () => {
    const shape = describeWorkerMessage({
      type: 'records',
      rows: [
        { id: 'a', text: 'hello' },
        { id: 'b', text: 'world!' }
      ]
    })
    expect(shape).toEqual({ kind: 'records', items: 2, bytes: 40, depth: 4, truncated: false })
  })

  it('never reads an accessor, which could change the message being sent', () => {
    let reads = 0
    const message = {
      type: 'state',
      get value() {
        reads += 1
        return reads
      }
    }
    describeWorkerMessage(message)
    expect(reads).toBe(0)

    const rows = new Map([['x'.repeat(1000), 'y']])
    Object.defineProperty(rows, 'size', {
      get() {
        rows.clear()
        return 0
      }
    })
    expect(describeWorkerMessage(rows)).toMatchObject({ items: 1, bytes: 1001 })
    expect(Map.prototype.entries.call(rows).next().done).toBe(false)
  })

  it('stays bounded on cyclic, deep and huge payloads', () => {
    // Wide and self-referential: each object is read once and keys share one budget.
    const cyclic: Record<string, unknown> = { type: 'loop' }
    for (let key = 0; key < 10_000; key += 1) {
      cyclic[`k${key}`] = cyclic
    }
    expect(describeWorkerMessage(cyclic)).toMatchObject({ kind: 'loop', items: 10_001 })

    let deep: Record<string, unknown> = { leaf: true }
    for (let level = 0; level < 100_000; level += 1) {
      deep = { next: deep }
    }
    const deepShape = describeWorkerMessage(deep)
    expect(deepShape.truncated).toBe(true)
    expect(deepShape.depth).toBe(2048)

    const huge = describeWorkerMessage({
      type: 'page',
      rows: Array.from({ length: 5_000_000 }, () => 1)
    })
    expect(huge).toMatchObject({ kind: 'page', items: 5_000_000, truncated: true })
  })
})
