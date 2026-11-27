import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { app, autoUpdater, powerMonitor } from 'electron'
import { UpdaterSetup } from './updater-setup'
import { beginMacUpdateDownload } from '../mac-install/updater-mac-install'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.4.279' }),
    autoUpdater: new EventEmitter(),
    powerMonitor: new EventEmitter()
  }
})
vi.mock('../mac-install/shipit-leftover-recovery', () => ({
  prepareThisProcessShipItStaging: () => null
}))
vi.mock('../mac-install/macos-shipit-scheduling', () => ({
  configureMacShipItScheduling: () => {}
}))
vi.mock('../linux-package/linux-update-package-type', () => ({
  getLinuxPackageType: () => 'non-root',
  getLinuxRootPackageType: () => null,
  isExternallyManagedLinuxInstall: () => false
}))
vi.mock('../electron-updater-loader', () => ({ loadElectronAutoUpdater: () => jsUpdater }))
vi.mock('../releases/updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: async () => ({ state: 'ready', tags: [`v${version}`] })
}))
vi.mock('../releases/updater-changelog', () => ({ fetchChangelog: async () => null }))

const version = '1.4.280'
const jsUpdater = Object.assign(new EventEmitter(), {
  setFeedURL: () => {},
  checkForUpdates: async () => {
    jsUpdater.emit('checking-for-update')
    jsUpdater.emit('update-available', { version })
  },
  downloadUpdate: async () => []
})

// Stands in for a team policy that requires the offered version; the rest is the real updater.
class TeamPolicyUpdater extends UpdaterSetup {
  requiredVersion: string | null = null
  protected override isRequiredTeamUpdate(candidate: string): boolean {
    return candidate === this.requiredVersion
  }
}

let updater: TeamPolicyUpdater

beforeEach(async () => {
  // Never reach the real install: it runs 100 ms after the decision, and timers stay frozen.
  vi.useFakeTimers({ now: 0 })
  updater = new TeamPolicyUpdater()
  updater.setupAutoUpdater(null, { getLastUpdateCheckAt: () => Date.now() })
  await offer()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  autoUpdater.removeAllListeners()
  app.removeAllListeners()
  powerMonitor.removeAllListeners()
  jsUpdater.removeAllListeners()
  beginMacUpdateDownload()
})

async function offer(): Promise<void> {
  updater.checkForUpdatesFromMenu()
  await vi.advanceTimersByTimeAsync(0)
  expect(updater.getUpdateStatus()).toMatchObject({ state: 'available', version })
}

function finishDownload(): void {
  jsUpdater.emit('update-downloaded', { version })
  autoUpdater.emit('update-downloaded')
}

function installStarted(): boolean {
  const status = updater.getUpdateStatus()
  expect(status).toMatchObject({ state: 'downloaded', version })
  return status.state === 'downloaded' && status.installing === true
}

it('a Settings download waits for Restart', () => {
  updater.downloadUpdate()
  finishDownload()
  expect(installStarted()).toBe(false)
})

it("the card's download installs when it finishes", () => {
  updater.downloadUpdate('install')
  finishDownload()
  expect(installStarted()).toBe(true)
})

it('a card click ignored while a Settings download runs does not claim it', () => {
  updater.downloadUpdate()
  updater.downloadUpdate('install')
  finishDownload()
  expect(installStarted()).toBe(false)
})

it('a failed card download does not carry over to the next Settings download', async () => {
  updater.downloadUpdate('install')
  jsUpdater.emit('error', new Error('net::ERR_CONNECTION_RESET'))
  await offer()
  updater.downloadUpdate()
  finishDownload()
  expect(installStarted()).toBe(false)
})

it('a card download taken over by team policy does not install once the policy lifts', () => {
  updater.downloadUpdate('install')
  updater.requiredVersion = version
  finishDownload()
  expect(updater.getUpdateStatus()).toMatchObject({ requiredByTeam: true })

  updater.requiredVersion = null
  updater.applyAutomaticUpdatesSetting()
  expect(installStarted()).toBe(false)
})
