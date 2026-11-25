import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const { checkForUpdates, setFeedURL } = vi.hoisted(() => ({
  checkForUpdates: vi.fn(async () => null),
  setFeedURL: vi.fn()
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.4.274' }),
    autoUpdater: new EventEmitter(),
    powerMonitor: new EventEmitter()
  }
})
vi.mock('../electron-updater-loader', () => ({
  loadElectronAutoUpdater: () => Object.assign(new EventEmitter(), { setFeedURL, checkForUpdates })
}))
vi.mock('../releases/updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: async () => ({ state: 'ready', tags: ['v1.4.275'] })
}))
vi.mock('../releases/updater-changelog', () => ({ fetchChangelog: async () => null }))
vi.mock('../../app-profiles/app-profile', () => ({
  getAppProfile: () => ({ id: 'work', name: 'Orca - Work' })
}))

import { UpdaterSetup } from './updater-setup'

it('checks for no update in a profile app, from the menu or in the background', async () => {
  const updater = new UpdaterSetup()
  updater.checkForUpdatesFromMenu()
  updater.checkForUpdates()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(checkForUpdates).not.toHaveBeenCalled()
  expect(updater.getUpdateStatus()).toMatchObject({ state: 'not-available' })
})

it('sets up no updater feed in a profile app', () => {
  new UpdaterSetup().setupAutoUpdater(null)
  expect(setFeedURL).not.toHaveBeenCalled()
})
