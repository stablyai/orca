import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock, nativeUpdaterMock } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return {
    appMock: Object.assign(new EventEmitter(), { quit: vi.fn() }),
    nativeUpdaterMock: new EventEmitter()
  }
})

vi.mock('electron', () => ({ app: appMock, autoUpdater: nativeUpdaterMock }))
vi.mock('./updater-lifecycle-diagnostics', () => ({ recordUpdaterLifecycle: vi.fn() }))

import {
  handleMacInstallerReady,
  markMacQuitAndInstallInFlight,
  registerMacUpdaterEvents,
  resetMacInstallState,
  setMacInstallPreflightInProgress
} from './updater-mac-install'

function quitEvent(): { defaultPrevented: boolean; preventDefault: () => void } {
  const event = {
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true
    }
  }
  return event
}

function registerGuard(hasUpdate: boolean, performQuitAndInstall = vi.fn()): void {
  registerMacUpdaterEvents({
    getCurrentStatus: () => ({ state: 'downloaded', version: '2.0.0' }),
    hasInstallableDownloadedVersion: () => hasUpdate,
    getPendingInstallVersion: () => '2.0.0',
    getKnownReleaseUrl: () => undefined,
    performQuitAndInstall,
    shouldDeferMacQuitForInstall: () => true,
    sendStatus: vi.fn()
  })
}

describe.runIf(process.platform === 'darwin')('macOS quit guard ordering', () => {
  beforeEach(() => {
    appMock.removeAllListeners()
    nativeUpdaterMock.removeAllListeners()
    resetMacInstallState()
    appMock.quit.mockReset()
  })

  it('vetoes a quit during install preflight before previously registered startup services shut down', () => {
    const shutdown = vi.fn()
    appMock.on('before-quit', (event) => {
      if (!event.defaultPrevented) {
        shutdown()
      }
    })
    registerGuard(true)
    handleMacInstallerReady(true, vi.fn(), vi.fn())
    setMacInstallPreflightInProgress(true)
    const event = quitEvent()

    appMock.emit('before-quit', event)

    expect(event.defaultPrevented).toBe(true)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('lets an ordinary quit with a staged update exit instead of converting it into a relaunching install', () => {
    // Why: restart flows call app.relaunch() then app.quit(); converting that quit into
    // quitAndInstall would race the relaunched old app against ShipIt.
    const install = vi.fn()
    registerGuard(true, install)
    handleMacInstallerReady(true, vi.fn(), vi.fn())
    const event = quitEvent()

    appMock.emit('before-quit', event)

    expect(event.defaultPrevented).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })

  it('vetoes duplicate quits through cleanup and allows the native install shutdown', () => {
    registerGuard(true)
    handleMacInstallerReady(true, vi.fn(), vi.fn())
    setMacInstallPreflightInProgress(true)
    markMacQuitAndInstallInFlight()
    for (let attempt = 0; attempt < 2; attempt++) {
      const event = quitEvent()
      appMock.emit('before-quit', event)
      expect(event.defaultPrevented).toBe(true)
    }

    setMacInstallPreflightInProgress(false)
    const nativeQuit = quitEvent()
    appMock.emit('before-quit', nativeQuit)
    expect(nativeQuit.defaultPrevented).toBe(false)
  })

  it('allows both ordinary quit passes after refusal and vetoes a new install attempt', () => {
    const install = vi.fn()
    registerGuard(true, install)
    handleMacInstallerReady(true, vi.fn(), vi.fn())
    resetMacInstallState()
    const normalQuit = quitEvent()
    appMock.emit('before-quit', normalQuit)
    expect(normalQuit.defaultPrevented).toBe(false)
    expect(install).not.toHaveBeenCalled()

    const teardownQuit = quitEvent()
    appMock.emit('before-quit', teardownQuit)
    expect(teardownQuit.defaultPrevented).toBe(false)
    expect(install).not.toHaveBeenCalled()

    setMacInstallPreflightInProgress(true)
    const retryQuit = quitEvent()
    appMock.emit('before-quit', retryQuit)
    expect(retryQuit.defaultPrevented).toBe(true)
    expect(install).not.toHaveBeenCalled()
  })

  it('allows ordinary quits when no update is available', () => {
    const install = vi.fn()
    registerGuard(false, install)
    const event = quitEvent()
    appMock.emit('before-quit', event)
    expect(event.defaultPrevented).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })
})
