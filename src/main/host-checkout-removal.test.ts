import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from './asar-transparent-fs'
import { removeHostCheckout } from './host-tree-removal'

vi.mock('./asar-transparent-fs', () => ({
  readdir: vi.fn(),
  rm: vi.fn(),
  unlink: vi.fn(),
  rmdir: vi.fn(),
  lstat: vi.fn()
}))
vi.mock('node:timers/promises', () => ({
  // Route promise backoff through the clock installed by vi.useFakeTimers.
  // ast-grep-ignore: test-no-real-time-wait -- Schedules the installed fake clock for production backoff.
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}))
const platform = process.platform
const root = 'C:/checkout-partition'
const busy = Object.assign(new Error('held child'), { code: 'EBUSY' })
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.useFakeTimers()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.useRealTimers()
  vi.resetAllMocks()
})

it('settles public child promises before starting another pass or touching the marker', async () => {
  vi.mocked(fs.readdir).mockResolvedValue(['held', 'pending', '.git'])
  const pending = Promise.withResolvers<void>()
  vi.mocked(fs.rm).mockImplementation(async (target) => {
    if (String(target).endsWith('held')) {
      throw busy
    }
    await pending.promise
  })
  const controller = new AbortController()
  const removal = removeHostCheckout(root, async () => true, controller.signal).catch(
    (error: unknown) => error
  )
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fs.unlink).not.toHaveBeenCalled()
  controller.abort()
  pending.resolve()
  await vi.runAllTimersAsync()
  expect(await removal).toMatchObject({ name: 'AbortError' })
  expect(fs.readdir).toHaveBeenCalledOnce()
})
