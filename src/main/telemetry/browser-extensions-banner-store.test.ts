import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createStore,
  readPersistedStateJson,
  testState,
  writeDataFile
} from '../persistence/persistence-test-harness'

const { trackMock } = vi.hoisted(() => ({
  trackMock: vi.fn((_name: string, _props: unknown) => true)
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir }
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('./client', () => ({
  isTelemetryEnabled: () => true,
  track: trackMock
}))
vi.mock('../browser/extensions/installation/browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ list: () => [] })
}))

import {
  assignBrowserExtensionsBanner,
  initBrowserExtensionsBanner
} from './browser-extensions-banner'

function savedOnDisk(): unknown {
  return JSON.parse(readPersistedStateJson()).settings?.telemetry?.browserExtensionsBanner
}

describe('browser extensions banner with the real settings store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    writeDataFile({
      settings: {
        browserExtensionsEnabled: true,
        telemetry: { optedIn: true, installId: 'install-1', existedBeforeTelemetryRelease: false }
      }
    })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('has the record on disk before reporting, and resumes it after a relaunch', async () => {
    const store = createStore()
    initBrowserExtensionsBanner(store)
    let onDiskAtReport: unknown
    trackMock.mockImplementationOnce(() => {
      onDiskAtReport = savedOnDisk()
      return false
    })

    expect(await assignBrowserExtensionsBanner()).toEqual({ status: 'deferred' })
    expect(onDiskAtReport).toMatchObject({ banner: 'colored_everyday', hadExtensions: false })
    expect(onDiskAtReport).not.toHaveProperty('reported')

    await closeTestStores()
    const relaunched = createStore()
    initBrowserExtensionsBanner(relaunched)
    trackMock.mockReturnValue(true)

    expect(await assignBrowserExtensionsBanner()).toEqual({
      status: 'active',
      banner: 'colored_everyday'
    })
    // The relaunch reports the record it loaded, keeping its original time.
    const reported = relaunched.getSettings().telemetry?.browserExtensionsBanner
    expect(reported).toMatchObject(Object.assign({}, onDiskAtReport))
    expect(reported?.reported).toBe(true)
  })
})
