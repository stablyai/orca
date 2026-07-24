import { describe, expect, it, vi } from 'vitest'
import { UnpairedDeviceAuthThrottle } from './unpaired-device-auth-throttle'

function throttleAt(clock: { time: number }, onTrigger = vi.fn()) {
  const throttle = new UnpairedDeviceAuthThrottle({
    onTrigger,
    failureThreshold: 3,
    windowMs: 60_000,
    now: () => clock.time
  })
  return { throttle, onTrigger }
}

describe('UnpairedDeviceAuthThrottle', () => {
  it('stays silent below the failure threshold', () => {
    const clock = { time: 0 }
    const { throttle, onTrigger } = throttleAt(clock)
    throttle.recordFailure()
    clock.time += 1000
    throttle.recordFailure()
    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('fires once when the threshold is reached inside the window', () => {
    const clock = { time: 0 }
    const { throttle, onTrigger } = throttleAt(clock)
    for (let i = 0; i < 3; i++) {
      throttle.recordFailure()
      clock.time += 500
    }
    expect(onTrigger).toHaveBeenCalledOnce()
  })

  it('never fires twice in one session even as failures continue', () => {
    const clock = { time: 0 }
    const { throttle, onTrigger } = throttleAt(clock)
    for (let i = 0; i < 20; i++) {
      throttle.recordFailure()
      clock.time += 500
    }
    expect(onTrigger).toHaveBeenCalledOnce()
  })

  it('ignores failures that fall outside the window', () => {
    const clock = { time: 0 }
    const { throttle, onTrigger } = throttleAt(clock)
    throttle.recordFailure()
    clock.time += 61_000
    throttle.recordFailure()
    clock.time += 61_000
    throttle.recordFailure()
    expect(onTrigger).not.toHaveBeenCalled()

    // A real retry burst after the stray singles still triggers.
    clock.time += 61_000
    throttle.recordFailure()
    clock.time += 100
    throttle.recordFailure()
    clock.time += 100
    throttle.recordFailure()
    expect(onTrigger).toHaveBeenCalledOnce()
  })
})
