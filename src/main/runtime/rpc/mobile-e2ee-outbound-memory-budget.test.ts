import { describe, expect, it } from 'vitest'
import { createMobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'

describe('mobile E2EE outbound memory budget', () => {
  it('bounds aggregate queued frames and releases claims exactly once', () => {
    const budget = createMobileE2EEOutboundMemoryBudget({
      maxQueuedBytes: 5,
      maxQueuedFrames: 2
    })
    const first = budget.claimQueuedBytes(3)
    const second = budget.claimQueuedBytes(2)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(budget.claimQueuedBytes(0)).toBeNull()
    expect(budget.evidence()).toMatchObject({ queuedBytes: 5, queuedFrames: 2 })

    first?.()
    first?.()
    expect(budget.claimQueuedBytes(3)).not.toBeNull()
  })

  it('bounds prospective native buffering across registered sockets', () => {
    let firstBuffered = 3
    let secondBuffered = 2
    const budget = createMobileE2EEOutboundMemoryBudget({
      maxBufferedBytes: 8,
      maxSocketSources: 2
    })
    const first = budget.registerBufferedAmount(() => firstBuffered)!
    const second = budget.registerBufferedAmount(() => secondBuffered)!

    expect(first.canSend(3)).toBe(true)
    expect(second.canSend(4)).toBe(false)
    expect(budget.registerBufferedAmount(() => 0)).toBeNull()

    first.release()
    firstBuffered = 100
    secondBuffered = 0
    expect(second.canSend(8)).toBe(true)
    expect(budget.evidence()).toMatchObject({ bufferedBytes: 0, sockets: 1 })
  })
})
