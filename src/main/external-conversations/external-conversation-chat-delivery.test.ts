import { describe, expect, it, vi } from 'vitest'
import { ChatDeliveries } from './external-conversation-chat-delivery'
import { HOST_CLOCK } from './external-conversation-host'

describe('ChatDeliveries.adopt', () => {
  it("links the chat and makes its running turn the conversation's, so the cloud mirrors it", () => {
    const link = vi.fn()
    const deliveries = new ChatDeliveries(link)
    const key = { source: 'slack' as const, externalId: 'trigger:abc' }
    const chat = { worktreeId: 'folder:home', sessionId: 's1', agent: 'claude' as const }

    deliveries.adopt(key, chat, 'Deploy pings')

    expect(link).toHaveBeenCalledWith(key, chat, 'Deploy pings')
    expect(deliveries.origin('s1', null)).toBe('delivery')
    expect(deliveries.origin('s1', null)).toBe('local')
  })
})

describe('ChatDeliveries.started', () => {
  const admitAt = (deliveries: ChatDeliveries, deliveryId: string, at: number) => {
    const clock = vi.spyOn(HOST_CLOCK, 'now').mockReturnValue(at)
    deliveries.admit('s1', deliveryId)
    clock.mockRestore()
  }

  it('names the one delivery a turn answers, and counts a turn told twice (a relink) once', () => {
    const deliveries = new ChatDeliveries(vi.fn())
    admitAt(deliveries, 'd1', 400)
    expect(deliveries.started('s1', 500)).toBe('d1')
    // A shared Chat linked again mid-turn tells the same turn again.
    expect(deliveries.started('s1', 500)).toBeUndefined()
    deliveries.origin('s1', 500)
    admitAt(deliveries, 'd2', 700)
    expect(deliveries.started('s1', 900)).toBe('d2')
  })

  it('lets an end close its own start and any before it, so one missed end leaks nothing', () => {
    const deliveries = new ChatDeliveries(vi.fn())
    expect(deliveries.started('s1', 500)).toBeUndefined()
    // 500's end never arrives (the chat was unlinked then); 900 runs and ends.
    expect(deliveries.started('s1', 900)).toBeUndefined()
    deliveries.origin('s1', 900)
    admitAt(deliveries, 'd3', 1_000)
    expect(deliveries.started('s1', 1_100)).toBe('d3')
  })

  it('closes the oldest open start for an end whose start is unknown', () => {
    const deliveries = new ChatDeliveries(vi.fn())
    expect(deliveries.started('s1', 500)).toBeUndefined()
    deliveries.origin('s1', null)
    admitAt(deliveries, 'd2', 700)
    expect(deliveries.started('s1', 900)).toBe('d2')
  })
})
