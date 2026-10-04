import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  beginMacUpdateDownload,
  deferMacQuitUntilInstallerReady,
  handleMacInstallerReady,
  isMacInstallRequested,
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

function registerGuard(
  hasUpdate: boolean,
  performQuitAndInstall = vi.fn(),
  status: 'downloaded' | 'downloading' = 'downloaded'
): void {
  registerMacUpdaterEvents({
    getCurrentStatus: () =>
      status === 'downloaded'
        ? { state: 'downloaded', version: '2.0.0' }
        : { state: 'downloading', percent: 100, version: '2.0.0' },
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
    beginMacUpdateDownload()
    appMock.quit.mockReset()
  })

  afterEach(() => {
    resetMacInstallState()
    vi.useRealTimers()
  })

  it('resumes an ordinary quit after native readiness without starting a relaunching install', () => {
    const install = vi.fn()
    registerGuard(true, install, 'downloading')
    const firstQuit = quitEvent()
    appMock.emit('before-quit', firstQuit)
    expect(firstQuit.defaultPrevented).toBe(true)

    nativeUpdaterMock.emit('update-downloaded')

    expect(appMock.quit).toHaveBeenCalledOnce()
    expect(install).not.toHaveBeenCalled()
    for (let pass = 0; pass < 2; pass++) {
      const resumedQuit = quitEvent()
      appMock.emit('before-quit', resumedQuit)
      expect(resumedQuit.defaultPrevented).toBe(false)
    }
  })

  it('keeps an explicit deferred install when an ordinary quit arrives afterward', async () => {
    const install = vi.fn()
    registerGuard(true, install, 'downloading')
    expect(
      deferMacQuitUntilInstallerReady(
        { state: 'downloading', percent: 100, version: '2.0.0' },
        true,
        () => '2.0.0',
        vi.fn()
      )
    ).toBe(true)
    const ordinaryQuit = quitEvent()
    appMock.emit('before-quit', ordinaryQuit)
    expect(ordinaryQuit.defaultPrevented).toBe(true)
    nativeUpdaterMock.emit('update-downloaded')
    const quitBeforeInstallCallback = quitEvent()
    appMock.emit('before-quit', quitBeforeInstallCallback)
    expect(quitBeforeInstallCallback.defaultPrevented).toBe(true)
    await Promise.resolve()

    expect(install).toHaveBeenCalledOnce()
    expect(appMock.quit).not.toHaveBeenCalled()
  })

  it('releases the requested install when readiness has no installable version', () => {
    const install = vi.fn()
    registerGuard(true, install, 'downloading')
    deferMacQuitUntilInstallerReady(
      { state: 'downloading', percent: 100, version: '2.0.0' },
      true,
      () => '2.0.0',
      vi.fn()
    )
    expect(isMacInstallRequested()).toBe(true)
    handleMacInstallerReady(false, install, vi.fn())
    expect(isMacInstallRequested()).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })

  it('releases the readiness handoff guard when the install callback rejects', async () => {
    registerGuard(true, vi.fn(), 'downloading')
    deferMacQuitUntilInstallerReady(
      { state: 'downloading', percent: 100, version: '2.0.0' },
      true,
      () => '2.0.0',
      vi.fn()
    )
    handleMacInstallerReady(
      true,
      () => {
        throw new Error('handoff rejected')
      },
      vi.fn()
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(isMacInstallRequested()).toBe(false)
    const ordinaryQuit = quitEvent()
    appMock.emit('before-quit', ordinaryQuit)
    expect(ordinaryQuit.defaultPrevented).toBe(false)
  })

  it('allows both timeout shutdown passes and revokes that allowance for a new deferred install', async () => {
    vi.useFakeTimers()
    const install = vi.fn()
    registerGuard(true, install, 'downloading')
    appMock.emit('before-quit', quitEvent())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(appMock.quit).toHaveBeenCalledOnce()
    for (let pass = 0; pass < 2; pass++) {
      const timeoutQuit = quitEvent()
      appMock.emit('before-quit', timeoutQuit)
      expect(timeoutQuit.defaultPrevented).toBe(false)
    }

    deferMacQuitUntilInstallerReady(
      { state: 'downloading', percent: 100, version: '2.0.0' },
      true,
      () => '2.0.0',
      vi.fn()
    )
    const retryQuit = quitEvent()
    appMock.emit('before-quit', retryQuit)
    expect(retryQuit.defaultPrevented).toBe(true)
    nativeUpdaterMock.emit('update-downloaded')
    await Promise.resolve()
    expect(install).toHaveBeenCalledOnce()
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
