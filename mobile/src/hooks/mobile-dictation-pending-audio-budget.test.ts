import { describe, expect, it } from 'vitest'
import { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'

describe('MobileDictationPendingAudioBudget', () => {
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
