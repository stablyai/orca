import { describe, expect, it } from 'vitest'
import { HeldPeerConversations } from './held-peer-conversations'

describe('conversations held back from a pull', () => {
  it('names the latest-due 50 past the cap, so the soonest due come back and are retried first', () => {
    const held = new HeldPeerConversations()
    for (let index = 0; index <= 50; index += 1) {
      held.failed(`conv_${index}`, 1_000 + index)
    }

    const { holdBack, waitMs } = held.forPull(1_100, 20_000)
    expect(holdBack).toHaveLength(50)
    expect(holdBack).not.toContain('conv_0')
    expect(holdBack).toContain('conv_50')
    expect(waitMs).toBe(1_900)
  })
})
