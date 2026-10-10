import { describe, expect, it, vi } from 'vitest'
import { createBrowserScreencastFrameAcks } from './browser-screencast-frame-acks'

describe('createBrowserScreencastFrameAcks', () => {
  it('acks frames once the host echoes frameAck on ready', () => {
    const sendAck = vi.fn()
    const acks = createBrowserScreencastFrameAcks(sendAck)
    acks.onFrame(1)
    acks.onEvent({ type: 'ready', subscriptionId: 'sub-1', frameAck: { window: 2 } })
    acks.onFrame(2)
    expect(sendAck.mock.calls).toEqual([['sub-1', 2]])
  })

  it('never acks a host that did not echo frameAck', () => {
    const sendAck = vi.fn()
    const acks = createBrowserScreencastFrameAcks(sendAck)
    acks.onEvent({ type: 'ready', subscriptionId: 'sub-1' })
    acks.onFrame(1)
    expect(sendAck).not.toHaveBeenCalled()
  })
})
