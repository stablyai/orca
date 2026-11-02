import { describe, expect, it } from 'vitest'
import { ProcessGoneDedupe } from './process-gone-dedupe'

describe('ProcessGoneDedupe', () => {
  it('allows an immediate retry after a failed claim is released', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 2_000 })
    const claim = dedupe.tryClaim('renderer', 1_000)

    expect(claim).not.toBeNull()
    expect(dedupe.tryClaim('renderer', 1_001)).toBeNull()
    dedupe.release(claim!)
    expect(dedupe.tryClaim('renderer', 1_001)).not.toBeNull()
  })

  it('does not release a newer claim when an older persistence attempt fails late', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 2_000 })
    const oldClaim = dedupe.tryClaim('renderer', 1_000)
    const currentClaim = dedupe.tryClaim('renderer', 3_000)

    expect(oldClaim).not.toBeNull()
    expect(currentClaim).not.toBeNull()
    dedupe.release(oldClaim!)
    expect(dedupe.tryClaim('renderer', 3_001)).toBeNull()
  })

  it('bounds unique keys during crash storms', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 60_000, maxKeys: 3 })

    expect(dedupe.shouldRecord('a', 1_000)).toBe(true)
    expect(dedupe.shouldRecord('b', 1_001)).toBe(true)
    expect(dedupe.shouldRecord('c', 1_002)).toBe(true)
    expect(dedupe.shouldRecord('d', 1_003)).toBe(true)

    expect(dedupe.size).toBe(3)
    expect(dedupe.shouldRecord('a', 1_004)).toBe(true)
  })
})
