import { describe, expect, it, vi } from 'vitest'
import { ChatDeliveries } from './external-conversation-chat-delivery'
import { HOST_CLOCK } from './external-conversation-host'
import type * as ChatModule from './external-conversation-chat'
import type { Delivery } from './external-conversation-types'

const chatModule = vi.hoisted(() => ({
  deliverToChat: vi.fn<typeof ChatModule.deliverToChat>()
}))
vi.mock('./external-conversation-chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatModule>()),
  deliverToChat: chatModule.deliverToChat
}))

describe('ChatDeliveries.deliver', () => {
  it('vetoes outbox silence at admission, before a rows-less send returns', async () => {
    const deliveries = new ChatDeliveries(vi.fn())
    const key = { source: 'slack' as const, externalId: 'T1:C1:1.0' }
    const chat = { worktreeId: 'folder:home', sessionId: 's1', agent: 'claude' as const }
    const send = (deliveryId: string, reply?: { account: string }) =>
      deliveries.deliver(undefined, key, chat, {
        text: 'hi',
        deliveryId,
        signal: new AbortController().signal,
        ...(reply ? { reply } : {})
      })
    chatModule.deliverToChat.mockImplementationOnce(async (_chat, _link, delivery) => {
      delivery.admitted?.()
      return { outcome: 'accepted' }
    })
    await send('d1', { account: 'a' })
    expect(deliveries.answeredThroughOutbox('s1')).toBe(true)

    let finish: (delivery: Delivery) => void = () => {}
    chatModule.deliverToChat.mockImplementationOnce((_chat, _link, delivery) => {
      delivery.admitted?.()
      return new Promise((resolve) => (finish = resolve))
    })
    const pending = send('d2')
    await vi.waitFor(() => expect(chatModule.deliverToChat).toHaveBeenCalledTimes(2))
    // A turn ending now answers the rows-less message too: no outbox row has its words.
    expect(deliveries.answeredThroughOutbox('s1')).toBe(false)
    finish({ outcome: 'accepted' })
    await pending
    expect(deliveries.answeredThroughOutbox('s1')).toBe(false)
  })
})

describe('ChatDeliveries.adopt', () => {
  it("links the chat and makes its running turn the conversation's, so the cloud mirrors it", () => {
    const link = vi.fn()
    const deliveries = new ChatDeliveries(link)
    const key = { source: 'slack' as const, externalId: 'trigger:abc' }
    const chat = { worktreeId: 'folder:home', sessionId: 's1', agent: 'claude' as const }

    deliveries.adopt(key, chat, 'Deploy pings')

    expect(link).toHaveBeenCalledWith(key, chat, 'Deploy pings')
    // No reply outbox row answers an adopted turn: its legacy end does.
    expect(deliveries.answeredThroughOutbox('s1')).toBe(false)
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
