import { describe, expect, it } from 'vitest'
import { ProcessGoneDedupe } from './process-gone-dedupe'

describe('ProcessGoneDedupe', () => {
  it('does not release a newer claim when an older persistence attempt fails late', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 2_000 })
    const oldClaim = dedupe.tryClaim('renderer', 1_000)
    const currentClaim = dedupe.tryClaim('renderer', 3_000)

    expect(oldClaim).not.toBeNull()
    expect(currentClaim).not.toBeNull()
    dedupe.release(oldClaim!)
    expect(dedupe.tryClaim('renderer', 3_001)).toBeNull()
  })
})
