import { describe, expect, it } from 'vitest'
import {
  MAX_RUNTIME_OPERATION_GENERATIONS,
  MAX_RUNTIME_OPERATION_GENERATION_KEY_BYTES,
  MAX_RUNTIME_OPERATION_GENERATION_RETAINED_KEY_BYTES,
  RuntimeOperationGenerations
} from './runtime-operation-generations'

const BOUNDS = {
  maxEntries: 2,
  maxKeyBytes: 4,
  maxRetainedKeyBytes: 6
}

describe('RuntimeOperationGenerations', () => {
  it('keeps a stable generation until the operation advances', () => {
    const generations = new RuntimeOperationGenerations(BOUNDS)
    const initial = generations.current('a')

    expect(generations.current('a')).toBe(initial)
    expect(generations.advance('a')).not.toBe(initial)
    expect(generations.isCurrent('a', initial)).toBe(false)
  })

  it('evicts least-recently-used keys and fails closed for stale captures', () => {
    const generations = new RuntimeOperationGenerations(BOUNDS)
    const first = generations.current('a')
    const evicted = generations.current('b')
    generations.current('a')
    const latest = generations.current('cc')

    expect(generations.isCurrent('a', first)).toBe(true)
    expect(generations.isCurrent('b', evicted)).toBe(false)
    expect(generations.isCurrent('cc', latest)).toBe(true)
    expect(generations.evidence()).toEqual({ entries: 2, retainedKeyBytes: 3 })
  })

  it('bounds aggregate retained key bytes', () => {
    const generations = new RuntimeOperationGenerations({
      maxEntries: 3,
      maxKeyBytes: 4,
      maxRetainedKeyBytes: 3
    })
    const evicted = generations.current('aa')
    generations.current('b')
    generations.current('cc')

    expect(generations.isCurrent('aa', evicted)).toBe(false)
    expect(generations.evidence()).toEqual({ entries: 2, retainedKeyBytes: 3 })
  })

  it('does not retain oversized keys', () => {
    const generations = new RuntimeOperationGenerations(BOUNDS)
    const generation = generations.current('oversized')

    expect(generations.isCurrent('oversized', generation)).toBe(false)
    expect(generations.evidence()).toEqual({ entries: 0, retainedKeyBytes: 0 })
  })

  it('invalidates forgotten owners without retaining tombstones', () => {
    const generations = new RuntimeOperationGenerations(BOUNDS)
    const stale = generations.current('a')
    generations.forget('a')

    expect(generations.isCurrent('a', stale)).toBe(false)
    expect(generations.current('a')).not.toBe(stale)
    expect(generations.evidence()).toEqual({ entries: 1, retainedKeyBytes: 1 })
  })

  it('publishes explicit production bounds', () => {
    expect(MAX_RUNTIME_OPERATION_GENERATIONS).toBe(8_192)
    expect(MAX_RUNTIME_OPERATION_GENERATION_KEY_BYTES).toBe(64 * 1024)
    expect(MAX_RUNTIME_OPERATION_GENERATION_RETAINED_KEY_BYTES).toBe(4 * 1024 * 1024)
  })
})
