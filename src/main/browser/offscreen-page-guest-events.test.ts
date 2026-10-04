import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { forwardOffscreenPageGuestEvents } from './offscreen-page-guest-events'

function fakeContents() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getURL: vi.fn(() => 'https://example.com/'),
    getTitle: () => 'Example',
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    isLoading: () => false,
    getZoomLevel: () => 0
  })
}

describe('forwardOffscreenPageGuestEvents', () => {
  it('reads page state for events that can change it, and skips it for console messages', () => {
    const contents = fakeContents()
    const emit = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the forwarder touches.
    const stop = forwardOffscreenPageGuestEvents(contents as never, emit)
    contents.emit('console-message', { message: 'tick', level: 'info' })
    expect(emit).toHaveBeenLastCalledWith({
      type: 'console-message',
      detail: { message: 'tick', level: 'info' }
    })
    expect(contents.getURL).not.toHaveBeenCalled()
    contents.emit('page-title-updated', {}, 'Example')
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'page-title-updated',
        state: expect.objectContaining({ title: 'Example' })
      })
    )
    stop()
    expect(contents.eventNames()).toEqual([])
  })
})
