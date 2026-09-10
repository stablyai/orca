import { describe, expect, it } from 'vitest'
import { canRetireDaemonGeneration } from './daemon-generation-inventory'

describe('canRetireDaemonGeneration', () => {
  it('admits only a proven gone empty noncanonical generation', () => {
    expect(
      canRetireDaemonGeneration({
        canonical: false,
        occupied: false,
        attached: false,
        owned: false,
        unverifiable: false,
        gone: true
      })
    ).toBe(true)
  })

  it.each(['canonical', 'occupied', 'attached', 'owned', 'unverifiable'] as const)(
    'never admits a %s generation',
    (guard) => {
      expect(
        canRetireDaemonGeneration({
          canonical: false,
          occupied: false,
          attached: false,
          owned: false,
          unverifiable: false,
          gone: true,
          [guard]: true
        })
      ).toBe(false)
    }
  )

  it('never treats an empty but live generation as retireable', () => {
    expect(
      canRetireDaemonGeneration({
        canonical: false,
        occupied: false,
        attached: false,
        owned: false,
        unverifiable: false,
        gone: false
      })
    ).toBe(false)
  })
})
