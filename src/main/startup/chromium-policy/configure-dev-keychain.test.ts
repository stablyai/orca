import { afterEach, describe, expect, it, vi } from 'vitest'

const appendSwitch = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ app: { commandLine: { appendSwitch } } }))

const { configureDevKeychain } = await import('./configure-dev-keychain')

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('configureDevKeychain', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.unstubAllEnvs()
    appendSwitch.mockClear()
  })

  it.each([
    { platform: 'darwin', isDev: true, useKeychain: undefined, mock: true },
    { platform: 'darwin', isDev: true, useKeychain: '0', mock: true },
    { platform: 'darwin', isDev: true, useKeychain: '1', mock: false },
    { platform: 'darwin', isDev: false, useKeychain: undefined, mock: false },
    { platform: 'linux', isDev: true, useKeychain: undefined, mock: false },
    { platform: 'win32', isDev: true, useKeychain: undefined, mock: false }
  ])(
    'mock keychain=$mock on $platform (dev=$isDev, ORCA_DEV_USE_KEYCHAIN=$useKeychain)',
    ({ platform, isDev, useKeychain, mock }) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      vi.stubEnv('ORCA_DEV_USE_KEYCHAIN', useKeychain)

      configureDevKeychain(isDev)

      if (mock) {
        expect(appendSwitch).toHaveBeenCalledWith('use-mock-keychain')
      } else {
        expect(appendSwitch).not.toHaveBeenCalled()
      }
    }
  )
})
