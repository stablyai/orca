import { describe, expect, it } from 'vitest'
import { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'

describe('MobileDictationPendingAudioBudget', () => {
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

  it('keeps a replayed backlog out of the live limit while live requests settle first', () => {
    const budget = new MobileDictationPendingAudioBudget(100)
    budget.reserveBacklog(150)
    expect(budget.takeBacklog(150)).toBe(150)
    expect(budget.tryReserve(60)).toBe(true)
    expect(budget.takeBacklog(60)).toBe(0)
    // The live request answers before the older backlog request does.
    budget.release(60, 0)
    expect(budget.tryReserve(90)).toBe(true)
    expect(budget.tryReserve(11)).toBe(false)
  })
})
