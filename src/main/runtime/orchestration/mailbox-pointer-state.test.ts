import { describe, expect, it, vi } from 'vitest'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import { markMailboxDeliveryDelivered } from './mailbox-pointer-delivery-validation'

describe('OrchestrationMailboxPointerState', () => {
  it('persists delivery before a Cursor fast-path redrive', () => {
    const markAsDelivered = vi.fn()
    markMailboxDeliveryDelivered({ markAsDelivered }, ['message-1'], false)
    expect(markAsDelivered).toHaveBeenCalledWith(['message-1'])
  })
  it('keeps an unknown attempt fenced until its PTY incarnation retires', () => {
    const state = new OrchestrationMailboxPointerState()
    state.setWatermark('run:1', 1, 'pty-1', 'pane-1')
    expect(state.deactivateWatermark('run:1', 1, 'pty-1')).toBe(true)
    expect(state.releaseSupersededWatermark('run:1', 2, 'pty-1', 'pane-1')).toBe(false)
    expect(state.releaseSupersededWatermark('run:1', 2, 'pty-2', 'pane-2')).toBe(true)
  })

  it('releases an unknown watermark with its retired PTY', () => {
    const state = new OrchestrationMailboxPointerState()
    state.setWatermark('run:1', 1, 'pty-1', 'pane-1')
    state.deactivateWatermark('run:1', 1, 'pty-1')

    expect(state.retirePty('pty-1').releasedMailboxes).toEqual(['run:1'])
    expect(state.releaseSupersededWatermark('run:1', 2, 'pty-2', 'pane-2')).toBe(true)
  })
})
