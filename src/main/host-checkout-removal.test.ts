import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from './asar-transparent-fs'
import { removeHostCheckout, removeHostEmptyDirectory } from './host-tree-removal'

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

it.each([10, 100])(
  'bounds N=%i root entries across child failure and the rmdir-only tail',
  async (width) => {
    const children = Array.from({ length: width }, (_, index) => `child-${index}`)
    vi.mocked(fs.readdir).mockResolvedValue([...children, '.git'])
    let attempts = 0
    vi.mocked(fs.rm).mockImplementation(async (target) => {
      if (String(target).endsWith('child-0') && ++attempts < 3) {
        throw busy
      }
    })
    let rootAttempts = 0
    vi.mocked(fs.rmdir).mockImplementation(async () => {
      throw Object.assign(new Error('new marker sentinel'), {
        code: ++rootAttempts === 1 ? 'EBUSY' : 'ENOTEMPTY'
      })
    })
    const authorize = vi.fn(async () => true)
    const removal = removeHostCheckout(root, authorize).catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(String(await removal)).toContain('folder was left on disk')
    expect(fs.rm).toHaveBeenCalledTimes(3 * width)
    expect(fs.rmdir).toHaveBeenCalledTimes(3)
    expect(fs.unlink).toHaveBeenCalledOnce()
    expect(fs.readdir).toHaveBeenCalledTimes(3)
    expect(authorize).toHaveBeenCalledTimes(6)
  }
)

it('does not mistake Windows rmdir ENOENT on an existing file for absence', async () => {
  const missing = Object.assign(new Error('not a directory'), { code: 'ENOENT' })
  vi.mocked(fs.rmdir).mockRejectedValue(missing)
  await expect(removeHostEmptyDirectory(root)).rejects.toBe(missing)
  const denied = Object.assign(new Error('unreadable replacement'), { code: 'EACCES' })
  vi.mocked(fs.lstat).mockRejectedValue(denied)
  await expect(removeHostEmptyDirectory(root)).rejects.toBe(denied)
  vi.mocked(fs.lstat).mockRejectedValue(missing)
  await expect(removeHostEmptyDirectory(root)).resolves.toBeUndefined()
})
