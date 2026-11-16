import { describe, expect, it } from 'vitest'
import { describeWorkerMessage } from './worker-message-shape'

describe('describeWorkerMessage', () => {
  it('names a reply and counts its rows and text', () => {
    const shape = describeWorkerMessage({
      type: 'records',
      rows: [{ id: 'a', text: 'hello' }, { id: 'b', text: 'world!' }]
    })
    expect(shape).toEqual({ kind: 'records', items: 2, bytes: 40, depth: 4, truncated: false })
  })

  it('stays bounded on cyclic, deep and huge payloads', () => {
    const cyclic: Record<string, unknown> = { type: 'loop' }
    cyclic.self = cyclic
    expect(describeWorkerMessage(cyclic).truncated).toBe(true)

    let deep: Record<string, unknown> = { leaf: true }
    for (let level = 0; level < 100_000; level += 1) {
      deep = { next: deep }
    }
    const deepShape = describeWorkerMessage(deep)
    expect(deepShape.truncated).toBe(true)
    expect(deepShape.depth).toBe(2048)

    const huge = describeWorkerMessage({ type: 'page', rows: new Array(5_000_000).fill(1) })
    expect(huge).toMatchObject({ kind: 'page', items: 5_000_000, truncated: true })
  })
})
