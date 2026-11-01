import { describe, expect, it, vi } from 'vitest'

const timings = vi.hoisted((): { to: number; config: Record<string, unknown> }[] => [])

vi.mock('react-native-gesture-handler', () => ({ Gesture: {} }))
vi.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (t: number) => t },
  ReduceMotion: { Never: 'never' },
  runOnJS: (fn: () => void) => fn,
  withTiming: (to: number, config: Record<string, unknown>, done?: (finished: boolean) => void) => {
    timings.push({ to, config })
    done?.(true)
    return to
  }
}))
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => false }))

import { hideDrawer, showDrawer } from './use-bottom-drawer-drag'

const drawer = (reducedMotion: boolean) => ({
  progress: { value: 0 },
  fade: { value: 0 },
  reducedMotion
})

describe('drawer motion under Reduce Motion', () => {
  it('opens in place with a 200 ms fade that Reduce Motion cannot skip', () => {
    timings.length = 0
    const motion = drawer(true)
    showDrawer(motion)
    expect(motion.progress.value).toBe(1)
    expect(timings).toEqual([{ to: 1, config: { duration: 200, reduceMotion: 'never' } }])
  })

  it('closes with the same fade and reports the drawer gone', () => {
    timings.length = 0
    const motion = drawer(true)
    motion.progress.value = 1
    const onDone = vi.fn()
    hideDrawer(motion, onDone)
    expect(motion.progress.value).toBe(1)
    expect(timings[0]).toMatchObject({ to: 0, config: { duration: 200 } })
    expect(onDone).toHaveBeenCalledOnce()
  })
})
