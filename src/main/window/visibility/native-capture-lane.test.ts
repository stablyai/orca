import { expect, it } from 'vitest'
import {
  isNativeCaptureBusy,
  occupyNativeCaptureLane,
  whenNativeCaptureLaneFree
} from './native-capture-lane'

it('wakes only the waits still registered when the capture settles', async () => {
  const target = {}
  let settle: (() => void) | undefined
  occupyNativeCaptureLane(
    target,
    new Promise<void>((resolve) => {
      settle = resolve
    })
  )
  const woken: number[] = []
  // Waits that gave up withdraw their registration; only the last one is still waiting.
  for (let i = 0; i < 3; i++) {
    const cancel = whenNativeCaptureLaneFree(target, () => woken.push(i))
    if (i < 2) {
      cancel()
    }
  }
  expect(isNativeCaptureBusy(target)).toBe(true)

  settle?.()
  await Promise.resolve()
  await Promise.resolve()
  expect(woken).toEqual([2])
  expect(isNativeCaptureBusy(target)).toBe(false)

  whenNativeCaptureLaneFree(target, () => woken.push(3))
  expect(woken).toEqual([2, 3])
})
