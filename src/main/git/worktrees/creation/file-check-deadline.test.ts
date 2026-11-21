import { afterEach, expect, it, vi } from 'vitest'
import { checkWithDeadline } from './file-check-deadline'

afterEach(() => vi.useRealTimers())

function heldCheck() {
  let release!: () => void
  const check = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(false)
      })
  )
  return { check, release: () => release() }
}

it('keeps a repo stalled until every expired check on it has settled', async () => {
  vi.useFakeTimers()
  const first = heldCheck()
  const second = heldCheck()
  const answers = Promise.all([
    checkWithDeadline('repo', 1_000, true, first.check),
    checkWithDeadline('repo', 1_000, true, second.check)
  ])
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(answers).resolves.toEqual([true, true])

  first.release()
  await vi.advanceTimersByTimeAsync(0)
  const whileOneIsHeld = vi.fn(() => Promise.resolve(false))
  await expect(checkWithDeadline('repo', 1_000, true, whileOneIsHeld)).resolves.toBe(true)
  expect(whileOneIsHeld).not.toHaveBeenCalled()

  second.release()
  await vi.advanceTimersByTimeAsync(0)
  await expect(checkWithDeadline('repo', 1_000, true, () => Promise.resolve(false))).resolves.toBe(
    false
  )
})
