// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { requestLazyChunkRecoveryReload } from './lazy-chunk-recovery-reload'

afterEach(() => {
  vi.restoreAllMocks()
})

it('relaunches instead of reloading when the bundle on disk is no longer the running build', async () => {
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)
  const relaunch = vi.fn(() => Promise.resolve())

  const outcome = await requestLazyChunkRecoveryReload(window, {
    awaitCheckpoint: () => Promise.resolve(),
    readInstalledBundleChange: () =>
      Promise.resolve({ changed: true, runningVersion: '1.4.255', installedVersion: '1.4.256' }),
    relaunch
  })

  expect(outcome).toBe('relaunch-requested')
  expect(relaunch).toHaveBeenCalledTimes(1)
  expect(reload).not.toHaveBeenCalled()
})
