import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOffscreenPageFrameRate } from './offscreen-page-frame-rate'

function fakeContents() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setFrameRate: vi.fn(),
    invalidate: vi.fn()
  })
}

describe('createOffscreenPageFrameRate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs at 60fps while shown and slowly while hidden', () => {
    const contents = fakeContents()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the pacer touches.
    const rate = createOffscreenPageFrameRate(contents as never)
    rate.setVisible(true)
    expect(contents.setFrameRate).toHaveBeenLastCalledWith(60)
    expect(contents.invalidate).toHaveBeenCalledOnce()
    rate.setVisible(false)
    expect(contents.setFrameRate).toHaveBeenLastCalledWith(10)
  })

  it('boosts a hidden page while it receives input, then settles back', () => {
    const contents = fakeContents()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the pacer touches.
    const rate = createOffscreenPageFrameRate(contents as never)
    rate.setVisible(false)
    contents.emit('input-event')
    expect(contents.setFrameRate).toHaveBeenLastCalledWith(60)
    vi.advanceTimersByTime(2000)
    contents.emit('input-event')
    vi.advanceTimersByTime(2000)
    expect(contents.setFrameRate).toHaveBeenLastCalledWith(60)
    vi.advanceTimersByTime(1500)
    expect(contents.setFrameRate).toHaveBeenLastCalledWith(10)
    rate.dispose()
    expect(contents.listenerCount('input-event')).toBe(0)
  })
})
