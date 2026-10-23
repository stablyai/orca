import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RendererPublicationThrottle,
  type RendererPublicationThrottleTarget
} from './renderer-publication-throttle'

function createTarget(
  capture: () => Promise<unknown> = () => Promise.resolve(null)
): RendererPublicationThrottleTarget & {
  calls: unknown[]
  destroyed: boolean
  focused: boolean
} {
  const calls: unknown[] = []
  return {
    calls,
    destroyed: false,
    focused: false,
    isDestroyed() {
      return this.destroyed
    },
    isFocused() {
      return this.focused
    },
    setBackgroundThrottling(allowed) {
      calls.push(allowed)
    },
    capturePage(rect, opts) {
      calls.push({ capture: rect, opts })
      return capture()
    }
  }
}

const REHIDE_CAPTURE = {
  capture: { x: 0, y: 0, width: 0, height: 0 },
  opts: { stayHidden: true }
}

describe('RendererPublicationThrottle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('unthrottles only while a publication lease is active', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()

    const release = throttle.acquire(target)
    release()

    expect(target.calls).toEqual([false])
    vi.runAllTimers()

    expect(target.calls).toEqual([false, true, REHIDE_CAPTURE])
  })

  it('keeps overlapping publications unthrottled until the last release', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()

    const releaseFirst = throttle.acquire(target)
    const releaseSecond = throttle.acquire(target)
    releaseFirst()
    expect(target.calls).toEqual([false])
    releaseSecond()
    releaseSecond()
    vi.runAllTimers()

    expect(target.calls).toEqual([false, true, REHIDE_CAPTURE])
  })

  it('skips the re-hide capture on a focused renderer, which a cover would have unfocused', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()

    const release = throttle.acquire(target)
    target.focused = true
    release()
    vi.runAllTimers()

    expect(target.calls).toEqual([false, true])
  })

  it('swallows a rejected re-hide capture', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const target = createTarget(() =>
        Promise.reject(new Error('Current display surface not available for capture'))
      )
      const throttle = new RendererPublicationThrottle()

      throttle.acquire(target)()
      await vi.runAllTimersAsync()

      expect(target.calls).toEqual([false, true, REHIDE_CAPTURE])
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('does not restore throttling on a destroyed renderer', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()

    const release = throttle.acquire(target)
    target.destroyed = true
    release()
    vi.runAllTimers()

    expect(target.calls).toEqual([false])
  })

  it('contains synchronous native capture errors in the deferred restore', () => {
    const target = createTarget(() => {
      throw new Error('Object has been destroyed')
    })
    const throttle = new RendererPublicationThrottle()
    throttle.acquire(target)()

    expect(() => vi.runAllTimers()).not.toThrow()
    expect(target.calls).toEqual([false, true, REHIDE_CAPTURE])
  })

  it('waits for native destruction to finish even when isDestroyed is initially false', async () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()
    const release = throttle.acquire(target)

    // Electron drains done.finally() from debugger detach before isDestroyed becomes true.
    await Promise.resolve().finally(release)
    expect(target.calls).toEqual([false])
    target.destroyed = true
    vi.runAllTimers()

    expect(target.calls).toEqual([false])
  })

  it('cancels a pending restore when a new publication acquires the target', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()
    throttle.acquire(target)()
    const release = throttle.acquire(target)

    vi.runAllTimers()
    expect(target.calls).toEqual([false, false])

    release()
    vi.runAllTimers()
    expect(target.calls).toEqual([false, false, true, REHIDE_CAPTURE])
  })

  it('restores only once after a publication starts and stops before the pending restore', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()
    throttle.acquire(target)()
    throttle.acquire(target)()
    vi.runAllTimers()

    expect(target.calls).toEqual([false, false, true, REHIDE_CAPTURE])
  })

  it('checks focus when the deferred restore runs', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()
    throttle.acquire(target)()
    target.focused = true
    vi.runAllTimers()

    expect(target.calls).toEqual([false, true])
  })

  it("does not cancel another target's pending restore", () => {
    const first = createTarget()
    const second = createTarget()
    const throttle = new RendererPublicationThrottle()
    throttle.acquire(first)()
    throttle.acquire(second)()
    const release = throttle.acquire(first)
    vi.runAllTimers()

    expect(first.calls).toEqual([false, false])
    expect(second.calls).toEqual([false, true, REHIDE_CAPTURE])

    release()
    vi.runAllTimers()
    expect(first.calls).toEqual([false, false, true, REHIDE_CAPTURE])
  })
})
