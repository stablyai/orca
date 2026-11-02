import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { UpdaterSetupOptions } from '../updater'

const { setupMock } = vi.hoisted(() => ({
  setupMock: vi.fn<(window: BrowserWindow | null, options?: UpdaterSetupOptions) => void>()
}))

vi.mock('electron', () => ({ app: {}, ipcMain: {} }))
vi.mock('../updater', () => ({ setupAutoUpdater: setupMock }))
vi.mock('../ipc/ui', () => ({ isTrustedUIRenderer: () => true }))
vi.mock('../startup/startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))

import { setupHeadlessServeAutoUpdater } from './main-window-updater'

function createStore() {
  const store = {
    getUI: vi.fn(() => ({ lastUpdateCheckAt: 5 })),
    updateUI: vi.fn(),
    flushPendingAsync: vi.fn<Store['flushPendingAsync']>().mockResolvedValue(undefined)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setup only reads getUI/updateUI/flushPendingAsync, all provided above.
  return { store, persistence: store as unknown as Store }
}

describe('setupHeadlessServeAutoUpdater', () => {
  afterEach(() => {
    setupMock.mockReset()
  })

  it('initializes the updater without a window, in the serve install mode, after readiness', async () => {
    const { store, persistence } = createStore()
    const beforeQuit = vi.fn()
    setupHeadlessServeAutoUpdater(persistence, {
      onBeforeUpdateQuit: beforeQuit,
      onBeforeUpdateQuitFailure: 'abort',
      updateInstallMode: 'supervised-headless-serve'
    })
    expect(setupMock).not.toHaveBeenCalled()
    await new Promise((resolve) => setImmediate(resolve))

    expect(setupMock).toHaveBeenCalledOnce()
    const [window, options] = setupMock.mock.calls[0] ?? []
    expect(window).toBeNull()
    expect(options).toMatchObject({
      installMode: 'supervised-headless-serve',
      onBeforeQuitFailure: 'abort'
    })
    expect(options?.getLastUpdateCheckAt?.()).toBe(5)
    await options?.onBeforeQuit?.()
    expect(beforeQuit).toHaveBeenCalledOnce()
    expect(store.flushPendingAsync).toHaveBeenCalledOnce()
  })

  it('never throws through serve startup when the updater cannot load', async () => {
    const { persistence } = createStore()
    setupMock.mockImplementation(() => {
      throw new Error('electron-updater missing')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setupHeadlessServeAutoUpdater(persistence, {})
    await new Promise((resolve) => setImmediate(resolve))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
