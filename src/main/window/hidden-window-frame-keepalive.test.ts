import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HIDDEN_WINDOW_FRAME_KEEPALIVE_MS,
  installHiddenWindowFrameKeepalive
} from './hidden-window-frame-keepalive'

function fakeWindow(visible = false) {
  const emitter = new EventEmitter()
  const state = { visible, destroyed: false }
  const invalidate = vi.fn()
  const window = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    once: (event: 'show' | 'closed', listener: () => void) => {
      emitter.once(event, listener)
    },
    webContents: { invalidate }
  }
  return { window, emitter, state, invalidate }
}

const BACKGROUND = { ORCA_BACKGROUND_LAUNCH: '1' }

describe('installHiddenWindowFrameKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('repaints a never-shown background window on Windows', () => {
    const { window, invalidate } = fakeWindow()
    installHiddenWindowFrameKeepalive(window, BACKGROUND, 'win32')

    vi.advanceTimersByTime(HIDDEN_WINDOW_FRAME_KEEPALIVE_MS * 3)

    expect(invalidate).toHaveBeenCalledTimes(3)
  })

  it.each(['darwin', 'linux'] as const)('does nothing on %s', (platform) => {
    const { window, invalidate } = fakeWindow()
    installHiddenWindowFrameKeepalive(window, BACKGROUND, platform)

    vi.advanceTimersByTime(HIDDEN_WINDOW_FRAME_KEEPALIVE_MS * 3)

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('does nothing for a normal launch', () => {
    const { window, invalidate } = fakeWindow()
    installHiddenWindowFrameKeepalive(window, {}, 'win32')

    vi.advanceTimersByTime(HIDDEN_WINDOW_FRAME_KEEPALIVE_MS * 3)

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('does nothing for a window that is already shown', () => {
    const { window, invalidate } = fakeWindow(true)
    installHiddenWindowFrameKeepalive(window, BACKGROUND, 'win32')

    vi.advanceTimersByTime(HIDDEN_WINDOW_FRAME_KEEPALIVE_MS * 3)

    expect(invalidate).not.toHaveBeenCalled()
  })

  it.each(['show', 'closed'] as const)('stops for good once the window emits %s', (event) => {
    const { window, emitter, state, invalidate } = fakeWindow()
    installHiddenWindowFrameKeepalive(window, BACKGROUND, 'win32')
    vi.advanceTimersByTime(HIDDEN_WINDOW_FRAME_KEEPALIVE_MS)

    emitter.emit(event)
    state.visible = false
    vi.advanceTimersByTime(HIDDEN_WINDOW_FRAME_KEEPALIVE_MS * 3)

    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops when the window is destroyed without a closed event', () => {
    const { window, state, invalidate } = fakeWindow()
    installHiddenWindowFrameKeepalive(window, BACKGROUND, 'win32')

    state.destroyed = true
    vi.advanceTimersByTime(HIDDEN_WINDOW_FRAME_KEEPALIVE_MS * 3)

    expect(invalidate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
