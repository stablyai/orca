import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { setupGuestMouseHistoryForwarding } from './browser-guest-mouse-history'

function setup(): {
  guest: EventEmitter
  send: ReturnType<typeof vi.fn>
  cleanup: () => void
} {
  const guest = new EventEmitter()
  const send = vi.fn()
  const cleanup = setupGuestMouseHistoryForwarding({
    browserTabId: 'tab-1',
    guest,
    resolveRenderer: () => ({ send })
  })
  return { guest, send, cleanup }
}

function press(
  guest: EventEmitter,
  type: 'mouseDown' | 'mouseUp' | 'mouseMove',
  button: string
): ReturnType<typeof vi.fn> {
  const preventDefault = vi.fn()
  guest.emit('before-mouse-event', { preventDefault }, { type, button, x: 0, y: 0 })
  return preventDefault
}

describe('guest mouse Back/Forward forwarding', () => {
  it('navigates the page back on Back release and swallows both edges', () => {
    const { guest, send } = setup()

    const down = press(guest, 'mouseDown', 'back')
    expect(send).not.toHaveBeenCalled()
    const up = press(guest, 'mouseUp', 'back')

    expect(down).toHaveBeenCalledOnce()
    expect(up).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledExactlyOnceWith('ui:browserHistoryNavigate', {
      browserPageId: 'tab-1',
      direction: 'back'
    })
  })

  it('navigates the page forward on Forward release', () => {
    const { guest, send } = setup()

    press(guest, 'mouseUp', 'forward')

    expect(send).toHaveBeenCalledExactlyOnceWith('ui:browserHistoryNavigate', {
      browserPageId: 'tab-1',
      direction: 'forward'
    })
  })

  it.each(['left', 'middle', 'right'])('leaves %s clicks to the page', (button) => {
    const { guest, send } = setup()

    const down = press(guest, 'mouseDown', button)
    const up = press(guest, 'mouseUp', button)

    expect(down).not.toHaveBeenCalled()
    expect(up).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores pointer moves with a side button held', () => {
    const { guest, send } = setup()

    expect(press(guest, 'mouseMove', 'back')).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('still swallows the press when the owning renderer is gone', () => {
    const guest = new EventEmitter()
    setupGuestMouseHistoryForwarding({
      browserTabId: 'tab-1',
      guest,
      resolveRenderer: () => null
    })

    expect(press(guest, 'mouseUp', 'back')).toHaveBeenCalledOnce()
  })

  it('stops forwarding after cleanup', () => {
    const { guest, send, cleanup } = setup()

    cleanup()
    press(guest, 'mouseUp', 'back')

    expect(send).not.toHaveBeenCalled()
    expect(guest.listenerCount('before-mouse-event')).toBe(0)
  })
})
