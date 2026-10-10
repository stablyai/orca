import { describe, expect, it, vi } from 'vitest'
import { restartOffersProvablyEmpty } from './structured-agent-session-restart-offer-read'

describe('reading restart offers without building a host', () => {
  it('answers empty only when no host exists and the capsule holds nothing', async () => {
    const recordsHeld = vi.fn(async () => false)
    expect(await restartOffersProvablyEmpty({ hostInstalled: () => false, recordsHeld })).toBe(true)
  })

  it('asks the installed host rather than the file', async () => {
    const recordsHeld = vi.fn(async () => false)
    expect(await restartOffersProvablyEmpty({ hostInstalled: () => true, recordsHeld })).toBe(false)
    expect(recordsHeld).not.toHaveBeenCalled()
  })

  it('builds the host when the capsule holds anything or cannot be read', async () => {
    expect(
      await restartOffersProvablyEmpty({
        hostInstalled: () => false,
        recordsHeld: async () => true
      })
    ).toBe(false)
    expect(
      await restartOffersProvablyEmpty({
        hostInstalled: () => false,
        recordsHeld: async () => {
          throw new Error('locked')
        }
      })
    ).toBe(false)
  })
})
