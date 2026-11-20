import { expect, it, vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'

const constructed = vi.fn()
const start = vi.fn(async () => {})
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

it('downloads the policy only once the cleanup asks, and stops for good when it is over', async () => {
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
  // Over: stopped, and a later ask reads the cache without starting downloads again.
  live.stopJournalRetirementPolicyUpdates()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(await live.journalRetirementMode()).toEqual({ mode: 'report', revision: 0 })
  expect(constructed).toHaveBeenCalledTimes(1)
})
