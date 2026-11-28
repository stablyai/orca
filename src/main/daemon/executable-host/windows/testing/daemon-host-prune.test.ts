import { afterEach, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../../../shared/app-lifecycle/app-environment'

const reclaim = vi.hoisted(() => ({ calls: 0, release: () => {} }))

vi.mock('../daemon-host-reclaim', () => ({
  reclaimUnownedDaemonHostDir: vi.fn(async () => {}),
  reclaimAbandonedDaemonHostStaging: vi.fn(() => {
    reclaim.calls += 1
    return new Promise<void>((resolve) => {
      reclaim.release = resolve
    })
  })
}))
vi.mock('../daemon-host-relocation', () => ({
  getDaemonHostRootDir: () => '/daemon-host-root',
  isPackagedElectronWin32: () => true
}))

import { pruneDaemonHostStaging } from '../daemon-host-prune'

setAppEnvironment({
  getPath: () => '/user-data',
  getAppPath: () => '/app.asar',
  getVersion: () => '9.9.9',
  isPackaged: () => true,
  onWillQuit: () => {},
  exit: () => {},
  getAppMetrics: () => []
})

afterEach(() => {
  reclaim.calls = 0
})

it('runs one staging walk for overlapping callers and a fresh one after it settles', async () => {
  const launcher = pruneDaemonHostStaging()
  const providerInit = pruneDaemonHostStaging()
  expect(reclaim.calls).toBe(1)
  reclaim.release()
  await Promise.all([launcher, providerInit])

  const later = pruneDaemonHostStaging()
  expect(reclaim.calls).toBe(2)
  reclaim.release()
  await later
})
