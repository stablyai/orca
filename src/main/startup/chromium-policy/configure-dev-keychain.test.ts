import { describe, expect, it, onTestFinished, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(),
    setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn(), hasSwitch: vi.fn(() => false) }
  }
}))

describe('configureDevKeychain', () => {
  it.each([
    { platform: 'darwin', packaged: false, useKeychain: undefined, mock: true },
    { platform: 'darwin', packaged: false, useKeychain: '1', mock: false },
    { platform: 'darwin', packaged: true, useKeychain: undefined, mock: false },
    { platform: 'win32', packaged: false, useKeychain: undefined, mock: false }
  ])(
    'selects mock=$mock on $platform (packaged=$packaged, opt-in=$useKeychain)',
    async ({ platform, packaged, useKeychain, mock }) => {
      const { app } = await import('electron')
      const { configureDevKeychain } = await import('./configure-dev-keychain')
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
      const originalPackaged = app.isPackaged
      onTestFinished(() => {
        Object.defineProperty(process, 'platform', originalPlatform)
        Object.defineProperty(app, 'isPackaged', { configurable: true, value: originalPackaged })
        vi.unstubAllEnvs()
      })
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: packaged })
      vi.stubEnv('ORCA_DEV_USE_KEYCHAIN', useKeychain)
      vi.mocked(app.commandLine.appendSwitch).mockClear()

      configureDevKeychain()

      if (mock) {
        expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('use-mock-keychain')
      } else {
        expect(app.commandLine.appendSwitch).not.toHaveBeenCalled()
      }
    }
  )
})
