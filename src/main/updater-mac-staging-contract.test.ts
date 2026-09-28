import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import type * as MacUpdaterModule from 'electron-updater/out/MacUpdater'
import type { Server } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(__filename)
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this is the installed dependency's declared CommonJS export, bypassing updater mocks.
const { MacUpdater } = require('electron-updater/out/MacUpdater') as typeof MacUpdaterModule

const pinnedPrototype: unknown = MacUpdater.prototype
if (
  !pinnedPrototype ||
  typeof pinnedPrototype !== 'object' ||
  !('updateDownloaded' in pinnedPrototype) ||
  typeof pinnedPrototype.updateDownloaded !== 'function' ||
  !('handleUpdateDownloaded' in pinnedPrototype) ||
  typeof pinnedPrototype.handleUpdateDownloaded !== 'function' ||
  !('quitAndInstall' in pinnedPrototype) ||
  typeof pinnedPrototype.quitAndInstall !== 'function'
) {
  throw new Error('Pinned MacUpdater staging contract changed')
}
const pinnedMethods = {
  updateDownloaded: pinnedPrototype.updateDownloaded,
  handleUpdateDownloaded: pinnedPrototype.handleUpdateDownloaded,
  quitAndInstall: pinnedPrototype.quitAndInstall
}

describe('pinned MacUpdater native staging contract', () => {
  it('downloads the payload without native staging until explicit installation', async () => {
    const lifecycle: string[] = []
    const native = Object.assign(new EventEmitter(), {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(() => lifecycle.push('native-staging-started')),
      quitAndInstall: vi.fn()
    })
    const serverSlot: { server?: Server } = {}
    const updater = {
      ...serverSlot,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: false,
      squirrelDownloadedUpdate: false,
      nativeUpdater: native,
      _logger: { info: vi.fn(), warn: vi.fn() },
      debug: vi.fn(),
      dispatchUpdateDownloaded: vi.fn(() => lifecycle.push('payload-downloaded')),
      app: { quit: vi.fn(() => lifecycle.push('app-quit')) },
      closeServerIfExists: (): void => {
        updater.server?.close()
      },
      handleUpdateDownloaded: (): void => {
        pinnedMethods.handleUpdateDownloaded.call(updater)
      }
    }
    try {
      // Known size avoids any payload read; the real implementation still opens its staging proxy.
      await pinnedMethods.updateDownloaded.call(
        updater,
        { url: new URL('https://example.invalid/update.zip'), info: { size: 1 } },
        { version: '1.0.61', downloadedFile: '/unused-contract-payload.zip' }
      )
      expect(lifecycle).toEqual(['payload-downloaded'])
      expect(native.setFeedURL).toHaveBeenCalledOnce()
      expect(native.checkForUpdates).not.toHaveBeenCalled()
      expect(native.listenerCount('update-downloaded')).toBe(0)
      expect(updater.app.quit).not.toHaveBeenCalled()

      pinnedMethods.quitAndInstall.call(updater)
      expect(lifecycle).toEqual(['payload-downloaded', 'native-staging-started'])
      expect(updater.app.quit).not.toHaveBeenCalled()
      native.emit('update-downloaded')
      expect(lifecycle).toEqual(['payload-downloaded', 'native-staging-started', 'app-quit'])
      expect(native.quitAndInstall).not.toHaveBeenCalled()
    } finally {
      updater.server?.close()
    }
  })
  it('observes native readiness before Orca quits, without retaining a future quit listener', () => {
    const native = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn()
    })
    const exports: Record<string, unknown> = {}
    const source = readFileSync(require.resolve('electron-updater/out/MacUpdater'), 'utf8')
    const dependencyRequire = createRequire(require.resolve('electron-updater/out/MacUpdater'))
    runInNewContext(source, {
      exports,
      Buffer,
      process,
      require: (name: string) =>
        name === 'electron' ? { autoUpdater: native } : dependencyRequire(name)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: executing the pinned CommonJS module above produces its declared exports with only Electron replaced.
    const Constructor = (exports as unknown as typeof MacUpdaterModule).MacUpdater
    const quit = vi.fn()
    const updater = new Constructor(undefined, {
      version: '1.0.51',
      name: 'Orca',
      isPackaged: true,
      appUpdateConfigPath: '',
      userDataPath: '',
      baseCachePath: '',
      whenReady: async () => {},
      relaunch: vi.fn(),
      quit,
      onQuit: vi.fn()
    })
    updater.autoInstallOnAppQuit = false
    updater.autoRunAppAfterInstall = false
    updater.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const errorOrder: string[] = []
    updater.on('error', () => errorOrder.push('forwarded-js-error'))
    native.on('error', () => errorOrder.push('authoritative-native-error'))
    native.emit('error', new Error('native staging rejected'))
    expect(errorOrder).toEqual(['forwarded-js-error', 'authoritative-native-error'])
    expect(quit).not.toHaveBeenCalled()
    let installOwned = true
    native.on('update-downloaded', () => {
      if (!installOwned) {
        return
      }
      installOwned = false
      updater.quitAndInstall()
    })
    const listeners = native.listenerCount('update-downloaded')
    native.checkForUpdates()
    expect(quit).not.toHaveBeenCalled()
    native.emit('update-downloaded')
    expect(quit).toHaveBeenCalledOnce()
    expect(native.listenerCount('update-downloaded')).toBe(listeners)
    native.emit('update-downloaded')
    expect(quit).toHaveBeenCalledOnce()
    expect(native.checkForUpdates).toHaveBeenCalledOnce()
  })
})
