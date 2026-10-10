import { describe, expect, it } from 'vitest'
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
  it('unthrottles only while a publication lease is active', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()

    const release = throttle.acquire(target)
    release()

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

    expect(target.calls).toEqual([false, true, REHIDE_CAPTURE])
  })

  it('skips the re-hide capture on a focused renderer, which a cover would have unfocused', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()

    const release = throttle.acquire(target)
    target.focused = true
    release()

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
      await new Promise((resolve) => setTimeout(resolve, 0))

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

    expect(target.calls).toEqual([false])
  })
})
