import { describe, expect, it, vi } from 'vitest'
import { getAppStartupSettings, setAppStartupSettings } from './app-startup-settings'

function createLoginItemApp(
  options: {
    isPackaged?: boolean
    settings?: Partial<Electron.LoginItemSettings>
  } = {}
): {
  isPackaged: boolean
  getLoginItemSettings: ReturnType<typeof vi.fn>
  setLoginItemSettings: ReturnType<typeof vi.fn>
} {
  return {
    isPackaged: options.isPackaged ?? true,
    getLoginItemSettings: vi.fn(
      () =>
        (options.settings ?? {
          openAtLogin: false,
          executableWillLaunchAtLogin: false
        }) as Electron.LoginItemSettings
    ),
    setLoginItemSettings: vi.fn()
  }
}

const WINDOWS_ENVIRONMENT = {
  platform: 'win32' as const,
  executablePath: 'C:\\Program Files\\Orca\\Orca.exe'
}

describe('app startup settings', () => {
  it('uses the effective Windows login-item state', () => {
    const loginItemApp = createLoginItemApp({
      settings: { openAtLogin: true, executableWillLaunchAtLogin: false }
    })

    expect(getAppStartupSettings(loginItemApp as never, WINDOWS_ENVIRONMENT)).toEqual({
      supported: true,
      canModify: true,
      openAtLogin: false
    })
    expect(loginItemApp.getLoginItemSettings).toHaveBeenCalledWith({
      path: WINDOWS_ENVIRONMENT.executablePath,
      args: []
    })
  })

  it('updates the same Windows login item and returns the refreshed state', () => {
    const loginItemApp = createLoginItemApp()
    loginItemApp.getLoginItemSettings
      .mockReturnValueOnce({ openAtLogin: false, executableWillLaunchAtLogin: false })
      .mockReturnValueOnce({ openAtLogin: true, executableWillLaunchAtLogin: true })

    expect(setAppStartupSettings(true, loginItemApp as never, WINDOWS_ENVIRONMENT)).toEqual({
      supported: true,
      canModify: true,
      openAtLogin: true
    })
    expect(loginItemApp.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: WINDOWS_ENVIRONMENT.executablePath,
      args: []
    })
  })

  it('does not offer mutation in development or on unsupported platforms', () => {
    const developmentApp = createLoginItemApp({ isPackaged: false })
    expect(getAppStartupSettings(developmentApp as never, WINDOWS_ENVIRONMENT)).toEqual({
      supported: true,
      canModify: false,
      openAtLogin: false
    })
    expect(() => setAppStartupSettings(true, developmentApp as never, WINDOWS_ENVIRONMENT)).toThrow(
      'installed desktop app'
    )

    const linuxApp = createLoginItemApp()
    expect(
      getAppStartupSettings(linuxApp as never, {
        platform: 'linux',
        executablePath: '/opt/orca/orca'
      })
    ).toEqual({ supported: false, canModify: false, openAtLogin: false })
  })
})
