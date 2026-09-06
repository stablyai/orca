import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why the NODE_ENV dance: react-native-web swaps its whole Animated implementation for a no-op
// AnimatedMock whenever NODE_ENV === 'test', so the real web driver is only observable if the
// module graph is loaded under another env. `platform.os` lets one mock serve both platforms.
const platform = vi.hoisted(() => ({ os: 'web' as string }))

vi.mock('react-native', async () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const web = await import('react-native-web')
    return {
      Animated: web.Animated,
      Easing: web.Easing,
      Platform: {
        get OS() {
          return platform.os
        }
      }
    }
  } finally {
    process.env.NODE_ENV = previous
  }
})

/** Drives Animated's JS driver: it reads Date.now(), so fake timers must move the clock. */
function installFrameClock(): void {
  vi.useFakeTimers()
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: (timestamp: number) => void) =>
      setTimeout(() => callback(Date.now()), 16) as unknown as number,
    cancelAnimationFrame: (handle: number) => clearTimeout(handle as never)
  })
}

async function loadRotationLoop() {
  vi.resetModules()
  return await import('./animated-rotation-loop')
}

describe('createRotationLoop', () => {
  beforeEach(() => {
    platform.os = 'web'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps rotating past the first turn on react-native-web', async () => {
    const { Animated } = await import('react-native')
    const { createRotationLoop } = await loadRotationLoop()
    installFrameClock()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const value = new Animated.Value(0)
    const samples: number[] = []
    value.addListener(({ value: sample }: { value: number }) => samples.push(sample))

    const animation = createRotationLoop(value, 1000)
    animation.start()
    vi.advanceTimersByTime(3500)
    animation.stop()

    // Each restart drops the value back toward 0; a single non-looping pass produces none.
    const turns = samples.filter((sample, index) => index > 0 && sample < samples[index - 1]).length
    expect(turns).toBeGreaterThanOrEqual(3)
    expect(samples.at(-1)).toBeLessThan(1)
  })

  it('does not claim the missing native driver on web', async () => {
    const { nativeAnimatedDriverSupported } = await loadRotationLoop()
    expect(nativeAnimatedDriverSupported).toBe(false)
  })

  it('still drives the native builds with the native driver', async () => {
    platform.os = 'android'
    const reactNative = await import('react-native')
    const timing = vi.spyOn(reactNative.Animated, 'timing')
    const { createRotationLoop, nativeAnimatedDriverSupported } = await loadRotationLoop()

    createRotationLoop(new reactNative.Animated.Value(0), 1000)

    expect(nativeAnimatedDriverSupported).toBe(true)
    expect(timing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toValue: 1, duration: 1000, useNativeDriver: true })
    )
  })
})
