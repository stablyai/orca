import { describe, expect, it } from 'vitest'
import { getProcessGoneDedupeKey, ProcessGoneDedupe } from './process-gone-dedupe'

describe('ProcessGoneDedupe', () => {
  it('suppresses duplicate keys inside the dedupe window', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 2_000 })
    const key = getProcessGoneDedupeKey('child', 'GPU', 'crashed', 5)

    expect(dedupe.shouldRecord(key, 1_000)).toBe(true)
    expect(dedupe.shouldRecord(key, 2_999)).toBe(false)
    expect(dedupe.shouldRecord(key, 3_000)).toBe(true)
  })

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

  it('prunes stale keys outside the dedupe window', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 2_000 })

    expect(dedupe.shouldRecord('a', 1_000)).toBe(true)
    expect(dedupe.shouldRecord('b', 1_500)).toBe(true)
    expect(dedupe.shouldRecord('c', 3_000)).toBe(true)

    expect(dedupe.size).toBe(2)
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

  it('coalesces renderer crash bursts across crash reasons and exit codes', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 2_000 })

    expect(
      dedupe.shouldRecord(getProcessGoneDedupeKey('renderer', 'renderer', 'crashed', -36861), 1_000)
    ).toBe(true)
    expect(
      dedupe.shouldRecord(getProcessGoneDedupeKey('renderer', 'renderer', 'oom', -536870904), 1_284)
    ).toBe(false)
    expect(
      dedupe.shouldRecord(
        getProcessGoneDedupeKey('renderer', 'renderer', 'launch-failed', 18),
        1_898
      )
    ).toBe(false)
    expect(
      dedupe.shouldRecord(
        getProcessGoneDedupeKey('renderer', 'renderer', 'launch-failed', 18),
        3_000
      )
    ).toBe(true)
  })

  it('keeps child process crash tuples distinct inside renderer burst windows', () => {
    const dedupe = new ProcessGoneDedupe({ windowMs: 2_000 })

    expect(
      dedupe.shouldRecord(getProcessGoneDedupeKey('child', 'Utility', 'crashed', 1), 1_000)
    ).toBe(true)
    expect(
      dedupe.shouldRecord(getProcessGoneDedupeKey('child', 'Utility', 'killed', 1), 1_100)
    ).toBe(true)
  })
})
