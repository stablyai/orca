import { describe, expect, it } from 'vitest'
import { CodexWslReconciliationGenerations } from './codex-wsl-reconciliation-generations'

const BOUNDS = {
  maxEntries: 2,
  maxKeyBytes: 4,
  maxTotalKeyBytes: 6
}

describe('CodexWslReconciliationGenerations', () => {
  it('invalidates an older reconciliation for the same runtime home', () => {
    const generations = new CodexWslReconciliationGenerations(BOUNDS)
    const stale = generations.advance('a')
    const current = generations.advance('a')

    expect(generations.isCurrent('a', stale)).toBe(false)
    expect(generations.isCurrent('a', current)).toBe(true)
  })

  it('bounds retained homes and fails closed for an evicted callback', () => {
    const generations = new CodexWslReconciliationGenerations(BOUNDS)
    const evicted = generations.advance('a')
    generations.advance('bb')
    generations.advance('ccc')

    expect(generations.isCurrent('a', evicted)).toBe(false)
    expect(generations.evidence()).toEqual({ entries: 2, keyBytes: 5 })
  })

  it('does not retain an oversized home key', () => {
    const generations = new CodexWslReconciliationGenerations(BOUNDS)
    const generation = generations.advance('oversized')

    expect(generations.isCurrent('oversized', generation)).toBe(false)
    expect(generations.evidence()).toEqual({ entries: 0, keyBytes: 0 })
  })
})
