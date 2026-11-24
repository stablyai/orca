// A connector delivery holds the chat from its send through its link: an end's check that runs at any
// point in between sees it, in either order the two can cross.
import { describe, expect, it, vi } from 'vitest'
import type { Delivery } from './external-conversation-types'

const send = vi.hoisted(() => {
  const holder: { run: null | ((admitted: () => void) => Promise<Delivery>) } = { run: null }
  return holder
})

vi.mock('./external-conversation-chat', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  deliverToChat: (_chat: unknown, _link: unknown, delivery: { admitted?: () => void }) =>
    send.run!(delivery.admitted ?? (() => {}))
}))

const { ChatDeliveries } = await import('./external-conversation-chat-delivery')

const KEY = { source: 'slack' as const, externalId: 'thread-1' }
const CHAT = { worktreeId: 'folder:home', sessionId: 's1', agent: 'claude' as const }
const message = () => ({ text: 'hi', deliveryId: 'd1', signal: new AbortController().signal })

describe('a delivery crossing an end of its chat', () => {
  it('stays pending from acceptance until its link is published', async () => {
    let linked = false
    const seen: boolean[] = []
    const deliveries = new ChatDeliveries(() => {
      linked = true
    })
    // An end's check, run on every microtask from the send's acceptance until the link.
    const watch = () => {
      if (!linked) {
        seen.push(deliveries.pending(CHAT.sessionId))
        queueMicrotask(watch)
      }
    }
    send.run = async (admitted) => {
      admitted()
      queueMicrotask(watch)
      return { outcome: 'accepted' }
    }

    expect(await deliveries.deliver(undefined, KEY, CHAT, message())).toEqual({
      outcome: 'accepted'
    })
    expect(linked).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
    expect(deliveries.pending(CHAT.sessionId)).toBe(true)
  })

  it('leaves nothing pending and links nothing when the end took the chat first', async () => {
    const link = vi.fn()
    const deliveries = new ChatDeliveries(link)
    let during: boolean | undefined
    // The ended chat's turn gate refuses the send before acceptance.
    send.run = async () => {
      during = deliveries.pending(CHAT.sessionId)
      return { outcome: 'refused', reason: 'agent_not_reachable' }
    }

    expect(await deliveries.deliver(undefined, KEY, CHAT, message())).toMatchObject({
      outcome: 'refused'
    })
    expect(during).toBe(true)
    expect(link).not.toHaveBeenCalled()
    expect(deliveries.pending(CHAT.sessionId)).toBe(false)
    expect(deliveries.waiting(CHAT.sessionId)).toBe(false)
  })
})
