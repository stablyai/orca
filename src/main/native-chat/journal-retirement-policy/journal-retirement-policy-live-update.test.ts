import { beforeEach, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'

const constructed = vi.fn()
let finishDownload = () => {}
const start = vi.fn(
  () =>
    new Promise<void>((resolve) => {
      finishDownload = resolve
    })
)
const stop = vi.fn()
vi.mock('../../remote-policies/release-asset-policy-live-update', () => ({
  ReleaseAssetPolicyLiveUpdater: class {
    constructor() {
      constructed()
    }
    start = start
    stop = stop
    refresh = async () => {}
    lastFetched = () => null
    newestKnown = async () => null
  },
  readCachedReleaseAssetPolicyAsync: async () => null
}))
vi.mock('../../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: () => '/nonexistent-user-data',
    getVersion: () => '1.4.270',
    isPackaged: () => true,
    onWillQuit: () => {}
  })
}))
vi.mock('../../network/http-client', () => ({ getMainHttpClient: () => ({ fetch }) }))

// Each test starts from a fresh module: its download state lives for the process.
beforeEach(() => {
  vi.resetModules()
  constructed.mockClear()
  start.mockClear()
  stop.mockClear()
})

it('gives an ask made before downloads were allowed its download, then stops', async () => {
  const live = await import('./journal-retirement-policy-live-update')
  const store = { getSettings: () => ({ telemetry: { installId: 'install' } }) }
  // The cleanup asks (reading only the cache) and finishes before the proxy settings apply.
  expect(await live.journalRetirementMode()).toEqual({ mode: 'report', revision: 0 })
  live.releaseJournalRetirementPolicyUpdates()
  expect(constructed).not.toHaveBeenCalled()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only getSettings is read.
  live.allowJournalRetirementPolicyUpdates(store as unknown as Store)
  expect(start).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  expect(stop).not.toHaveBeenCalled()
  finishDownload()
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
})

it('downloads the policy only once the cleanup asks, and stops after the download in flight', async () => {
  const live = await import('./journal-retirement-policy-live-update')
  const store = { getSettings: () => ({ telemetry: { installId: 'install' } }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only getSettings is read.
  live.allowJournalRetirementPolicyUpdates(store as unknown as Store)
  // Allowed at startup, but nothing downloads until the cleanup asks.
  expect(constructed).not.toHaveBeenCalled()
  expect(await live.journalRetirementMode()).toEqual({ mode: 'report', revision: 0 })
  expect(constructed).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledTimes(1)
  await live.journalRetirementMode()
  expect(constructed).toHaveBeenCalledTimes(1)
  // Released mid-download: it stops only once that download has written the cache, so a newer
  // revision still replaces a cached off.
  live.releaseJournalRetirementPolicyUpdates()
  await Promise.resolve()
  expect(stop).not.toHaveBeenCalled()
  finishDownload()
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
  // A cleanup that asks again starts downloads again.
  await live.journalRetirementMode()
  expect(constructed).toHaveBeenCalledTimes(2)
})
