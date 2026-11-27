import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.4.261' }),
    autoUpdater: new EventEmitter(),
    powerMonitor: new EventEmitter()
  }
})
vi.mock('../mac-install/macos-shipit-scheduling', () => ({
  configureMacShipItScheduling: () => {}
}))
vi.mock('../electron-updater-loader', () => ({ loadElectronAutoUpdater: () => jsUpdater }))
vi.mock('../releases/updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: async () => ({ state: 'ready', tags: ['v1.4.280'] })
}))
vi.mock('../releases/updater-changelog', () => ({ fetchChangelog: async () => null }))

// Like electron-updater's AppImageUpdater without $APPIMAGE: the check resolves null and emits nothing.
const jsUpdater = Object.assign(new EventEmitter(), {
  setFeedURL: () => {},
  checkForUpdates: vi.fn(async () => null),
  downloadUpdate: async () => []
})

const originalPlatform = process.platform
const originalResourcesPath = process.resourcesPath
const originalAppImage = process.env.APPIMAGE
let root: string

async function createLinuxAppImageUpdater(appImagePath: string | undefined) {
  if (appImagePath === undefined) {
    delete process.env.APPIMAGE
  } else {
    process.env.APPIMAGE = appImagePath
  }
  // The package-type cache is module state; each case needs a fresh classification.
  vi.resetModules()
  const { UpdaterSetup } = await import('./updater-setup')
  const updater = new UpdaterSetup()
  updater.setupAutoUpdater(null, { getLastUpdateCheckAt: () => Date.now() })
  return updater
}

// Load the updater graph during collection, outside per-test timeouts; cases only re-evaluate it.
await import('./updater-setup')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-remote-update-support-'))
  const resourcesPath = join(root, 'resources')
  // An extracted AppImage tree still carries the AppImage package-type marker.
  mkdirSync(resourcesPath)
  writeFileSync(join(resourcesPath, 'package-type'), 'AppImage\n')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true })
  jsUpdater.checkForUpdates.mockClear()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  Object.defineProperty(process, 'resourcesPath', {
    value: originalResourcesPath,
    configurable: true
  })
  if (originalAppImage === undefined) {
    delete process.env.APPIMAGE
  } else {
    process.env.APPIMAGE = originalAppImage
  }
  jsUpdater.removeAllListeners()
  rmSync(root, { recursive: true, force: true })
})

it('reports manual update for an extracted AppImage tree the native updater cannot replace', async () => {
  const updater = await createLinuxAppImageUpdater(undefined)

  expect(updater.getRemoteServerUpdateSupport()).toEqual({
    installMode: 'interactive',
    automatic: false,
    reason: 'manual-service-update-required'
  })
  // A remote check must be refused, not settled as "not available" by the inactive updater.
  expect(() => updater.checkForRemoteServerUpdate('runtime-1')).toThrow(
    'remote_update_manual_required'
  )
  expect(jsUpdater.checkForUpdates).not.toHaveBeenCalled()
  expect(updater.getUpdateStatus().state).not.toBe('not-available')
})

it('keeps automatic remote updates for a mounted AppImage', async () => {
  const appImagePath = join(root, 'orca-linux.AppImage')
  writeFileSync(appImagePath, '')
  const updater = await createLinuxAppImageUpdater(appImagePath)

  expect(updater.getRemoteServerUpdateSupport()).toEqual({
    installMode: 'interactive',
    automatic: true,
    reason: 'available'
  })
  expect(updater.checkForRemoteServerUpdate('runtime-1').status.state).toBe('checking')
})
