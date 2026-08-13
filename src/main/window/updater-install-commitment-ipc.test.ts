import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UPDATER_IS_INSTALL_COMMITTED_SYNC_CHANNEL } from '../../shared/updater-install-events'

// Covers the responder itself: a document born mid-install reads its answer
// synchronously in preload, so returning anything but the live value re-enables
// reads from an archive the installer is replacing.
const { onMock, removeAllListenersMock } = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeAllListenersMock: vi.fn()
}))

// Keep the real commitment module (it is the thing under test) but stub the heavy
// updater graph the registration file also imports.
vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  dismissNudge: vi.fn(),
  dismissAvailableUpdate: vi.fn(),
  getLinuxPackageInstallInstructions: vi.fn(),
  showLinuxPackage: vi.fn(),
  listBuilds: vi.fn(),
  setupAutoUpdater: vi.fn(),
  checkForUpdatesFromMenu: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getVersion: () => '0.0.0-test' },
  clipboard: {},
  systemPreferences: { askForMediaAccess: vi.fn(), getMediaAccessStatus: vi.fn() },
  ipcMain: {
    on: onMock,
    removeAllListeners: removeAllListenersMock,
    removeListener: vi.fn(),
    removeHandler: vi.fn(),
    handle: vi.fn()
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() }
}))

import {
  clearUpdaterInstallCommitted,
  markUpdaterInstallCommitted,
  resetUpdaterInstallCommitmentForTest
} from '../updater-install-commitment'
import { registerUpdaterHandlers } from './attach-main-window-services'

function syncListener(): (event: { returnValue?: unknown }) => void {
  const call = onMock.mock.calls.find(
    ([channel]) => channel === UPDATER_IS_INSTALL_COMMITTED_SYNC_CHANNEL
  )
  if (!call) {
    throw new Error('no synchronous install-commitment responder was registered')
  }
  return call[1] as (event: { returnValue?: unknown }) => void
}

describe('synchronous install-commitment responder', () => {
  beforeEach(() => {
    onMock.mockClear()
    resetUpdaterInstallCommitmentForTest()
    registerUpdaterHandlers({} as never)
  })

  afterEach(() => {
    resetUpdaterInstallCommitmentForTest()
  })

  it('answers false while no install is committed', () => {
    const event: { returnValue?: unknown } = {}

    syncListener()(event)

    expect(event.returnValue).toBe(false)
  })

  it('answers with the live commitment, not a constant', () => {
    markUpdaterInstallCommitted()
    const event: { returnValue?: unknown } = {}

    syncListener()(event)

    expect(event.returnValue).toBe(true)
  })

  it('goes back to false once the install is stood down', () => {
    markUpdaterInstallCommitted()
    clearUpdaterInstallCommitted()
    const event: { returnValue?: unknown } = {}

    syncListener()(event)

    expect(event.returnValue).toBe(false)
  })
})
