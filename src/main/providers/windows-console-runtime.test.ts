import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), version: vi.fn(), shutdown: vi.fn() }))
vi.mock('../daemon/daemon-bun-runtime', () => ({ resolveDesktopDaemonBunRuntime: mocks.resolve }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({
    getAppPath: () => '/app',
    getVersion: mocks.version,
    onWillQuit: mocks.shutdown
  })
}))
import {
  acquireWindowsConsoleRuntime,
  disposeWindowsConsoleRuntime
} from './windows-console-runtime'
beforeEach(() => {
  vi.stubGlobal('process', { ...process, versions: { ...process.versions, electron: '43.7.0' } })
  mocks.resolve.mockReset()
  mocks.version.mockReturnValue('first')
})
afterEach(() => {
  disposeWindowsConsoleRuntime()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('holds invalidated pins until concurrent pending launches release them', async () => {
  const releaseLaunchPin = vi.fn()
  mocks.resolve.mockResolvedValue({
    execPath: '/bun',
    entryPath: '/daemon-entry.js',
    releaseLaunchPin
  })
  const first = await acquireWindowsConsoleRuntime(1000)
  const second = await acquireWindowsConsoleRuntime(1000)
  expect(mocks.resolve).toHaveBeenCalledTimes(1)
  first?.invalidate()
  first?.release()
  await Promise.resolve()
  expect(releaseLaunchPin).not.toHaveBeenCalled()
  second?.release()
  await Promise.resolve()
  expect(releaseLaunchPin).toHaveBeenCalledTimes(1)
  second?.release()
  expect(releaseLaunchPin).toHaveBeenCalledTimes(1)
})
it('releases a late resolver after every waiter has timed out', async () => {
  vi.useFakeTimers()
  const releaseLaunchPin = vi.fn()
  let finish:
    | ((runtime: { execPath: string; entryPath: string; releaseLaunchPin: () => void }) => void)
    | undefined
  mocks.resolve.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const pending = acquireWindowsConsoleRuntime(10)
  const failure = expect(pending).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(10)
  await failure
  finish?.({ execPath: '/bun', entryPath: '/daemon-entry.js', releaseLaunchPin })
  await vi.advanceTimersByTimeAsync(1)
  expect(releaseLaunchPin).toHaveBeenCalledTimes(1)
})
it('releases replaced and disposed caches without invalidating successors', async () => {
  const oldRelease = vi.fn(),
    newRelease = vi.fn()
  mocks.resolve
    .mockResolvedValueOnce({
      execPath: '/old',
      entryPath: '/old/daemon-entry.js',
      releaseLaunchPin: oldRelease
    })
    .mockResolvedValueOnce({
      execPath: '/new',
      entryPath: '/new/daemon-entry.js',
      releaseLaunchPin: newRelease
    })
  const old = await acquireWindowsConsoleRuntime(1000)
  old?.release()
  mocks.version.mockReturnValue('second')
  const current = await acquireWindowsConsoleRuntime(1000)
  current?.release()
  expect(oldRelease).toHaveBeenCalledTimes(1)
  old?.invalidate()
  expect(newRelease).not.toHaveBeenCalled()
  disposeWindowsConsoleRuntime()
  await Promise.resolve()
  expect(newRelease).toHaveBeenCalledTimes(1)
})
