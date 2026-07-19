import { describe, expect, it, vi } from 'vitest'
import {
  HerdrEventSubscriptionBuffer,
  herdrEventsSubscribeRequest
} from './herdr-event-subscription'

describe('Herdr event subscription', () => {
  it('requests lifecycle replay from the snapshot revision', () => {
    const request = JSON.parse(herdrEventsSubscribeRequest(42)) as {
      method: string
      params: { after_sequence: number; subscriptions: { type: string }[] }
    }
    expect(request.method).toBe('events.subscribe')
    expect(request.params.after_sequence).toBe(42)
    expect(request.params.subscriptions).toContainEqual({ type: 'layout.updated' })
  })

  it('buffers events and typed stale cursor errors until listeners attach', () => {
    const release = vi.fn()
    const subscription = new HerdrEventSubscriptionBuffer(release)
    subscription.acceptLine(
      JSON.stringify({ sequence: 8, event: 'pane.created', data: { pane_id: 'p1' } })
    )
    subscription.acceptLine(
      JSON.stringify({ id: 'sub', error: { code: 'stale_cursor', message: 'expired' } })
    )
    const events = vi.fn()
    const errors = vi.fn()
    subscription.onEvent(events)
    subscription.onError(errors)
    expect(events).toHaveBeenCalledWith({
      sequence: 8,
      event: 'pane.created',
      data: { pane_id: 'p1' }
    })
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: 'stale_cursor' }))
    subscription.release()
    expect(release).toHaveBeenCalledOnce()
  })
})
