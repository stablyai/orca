import { describe, expect, it, vi } from 'vitest'
import { handleBrowserScreencastEvent } from './mobile-browser-stream-events'

function handlerArgs() {
  return {
    busyRef: { current: true },
    clearStartupTimer: vi.fn(),
    lastZoomResetUrlRef: { current: '' },
    resetBrowserZoomState: vi.fn(),
    setAddressValue: vi.fn(),
    setBusy: vi.fn(),
    setDialog: vi.fn(),
    setError: vi.fn()
  }
}

describe('handleBrowserScreencastEvent', () => {
  // Why: the host adds screencast event types without a capability gate, so a client
  // that predates one must ignore it rather than throw or disturb the stream's state.
  it('ignores an event type it does not recognize', () => {
    const args = handlerArgs()

    expect(() =>
      handleBrowserScreencastEvent({ ...args, event: { type: 'not-a-known-event' } })
    ).not.toThrow()

    expect(args.clearStartupTimer).not.toHaveBeenCalled()
    expect(args.setAddressValue).not.toHaveBeenCalled()
    expect(args.setBusy).not.toHaveBeenCalled()
    expect(args.setDialog).not.toHaveBeenCalled()
    expect(args.setError).not.toHaveBeenCalled()
    expect(args.busyRef.current).toBe(true)
  })

  it('still routes a recognized event', () => {
    const args = handlerArgs()

    handleBrowserScreencastEvent({ ...args, event: { type: 'dialogClosed' } })

    expect(args.setDialog).toHaveBeenCalledWith(null)
  })
})
