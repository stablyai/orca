import { describe, expect, it } from 'vitest'
import { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'

describe('MobileDictationPendingAudioBudget', () => {
  it('caps pending raw PCM audio at five seconds', () => {
    const budget = new MobileDictationPendingAudioBudget()
    expect(budget.tryReserve(159_999)).toBe(true)
    expect(budget.tryReserve(1)).toBe(true)
    expect(budget.pendingAudioBytes).toBe(160_000)
    expect(budget.tryReserve(1)).toBe(false)
    expect(budget.pendingAudioBytes).toBe(160_000)
  })

  it('releases completed chunks and clamps stale releases after reset', () => {
    const budget = new MobileDictationPendingAudioBudget(10)

    expect(budget.tryReserve(6)).toBe(true)
    budget.release(4)
    expect(budget.pendingAudioBytes).toBe(2)
    expect(budget.tryReserve(8)).toBe(true)

    budget.reset()
    budget.release(6)
    expect(budget.pendingAudioBytes).toBe(0)
    expect(budget.tryReserve(10)).toBe(true)
  })
})
