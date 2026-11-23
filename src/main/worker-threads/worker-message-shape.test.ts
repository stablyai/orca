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
})
