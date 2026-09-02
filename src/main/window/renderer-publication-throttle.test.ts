import { describe, expect, it } from 'vitest'
import {
  RendererPublicationThrottle,
  type RendererPublicationThrottleTarget
} from './renderer-publication-throttle'

function createTarget(): RendererPublicationThrottleTarget & {
  calls: boolean[]
  destroyed: boolean
} {
  const calls: boolean[] = []
  return {
    calls,
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    setBackgroundThrottling(allowed) {
      calls.push(allowed)
    }
  }
}

describe('RendererPublicationThrottle', () => {
  it('unthrottles only while a publication lease is active', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()

    const release = throttle.acquire(target)
    release()

    expect(target.calls).toEqual([false, true])
  })

  it('keeps overlapping publications unthrottled until the last release', () => {
    const target = createTarget()
    const throttle = new RendererPublicationThrottle()

    const releaseFirst = throttle.acquire(target)
    const releaseSecond = throttle.acquire(target)
    releaseFirst()
    releaseSecond()
    releaseSecond()

    expect(target.calls).toEqual([false, true])
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
