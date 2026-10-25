import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appRelaunchMock, hasSwitchMock, recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  appRelaunchMock: vi.fn(),
  hasSwitchMock: vi.fn<(name: string) => boolean>(() => false),
  recordDurableCrashBreadcrumbMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { relaunch: appRelaunchMock, commandLine: { hasSwitch: hasSwitchMock } }
}))
vi.mock('./windows/windows-administrator-status', () => ({
  getWindowsAdministratorStatus: vi.fn(async () => true)
}))
vi.mock('./daemon/daemon-provider-restart', () => ({ restartDaemon: vi.fn(async () => {}) }))
vi.mock('./crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

import { relaunchApp } from './app-relaunch'
import { restartLocalTerminalsAfterElevation } from './windows/windows-administrator-restart'
import { _resetHydrateShellPathCache, _setLaunchPathForTests } from './startup/hydrate-shell-path'

beforeEach(() => {
  appRelaunchMock.mockReset()
  hasSwitchMock.mockReset().mockReturnValue(false)
  recordDurableCrashBreadcrumbMock.mockReset()
})

const originalPath = process.env.PATH
const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
  _resetHydrateShellPathCache()
  if (originalPath === undefined) {
    delete process.env.PATH
  } else {
    process.env.PATH = originalPath
  }
})

describe('relaunchApp', () => {
  it('does not replay native administrator restart arguments before or after consumption', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const flag = '--orca-restart-local-terminals-as-administrator'
    const nativeArgv = ['Orca.exe', '--user-data-dir=C:\\Orca profile', flag]
    process.argv = [...nativeArgv]
    hasSwitchMock.mockImplementation((name: string) => nativeArgv.includes(`--${name}`))
    let nextArgs: string[] | undefined
    appRelaunchMock.mockImplementation((options?: Electron.RelaunchOptions) => {
      nextArgs = options?.args ?? nativeArgv.slice(1)
    })

    relaunchApp('renderer-request')
    expect(nextArgs).toEqual(['--user-data-dir=C:\\Orca profile'])
    await restartLocalTerminalsAfterElevation(new AbortController().signal)
    expect(process.argv).not.toContain(flag)
    expect(nativeArgv).toContain(flag)
    relaunchApp('profile-switch')
    expect(nextArgs).toEqual(['--user-data-dir=C:\\Orca profile'])

    const custom = { execPath: 'administrator-launcher.exe', args: ['restart', flag] }
    relaunchApp('windows-administrator', undefined, custom)
    expect(appRelaunchMock).toHaveBeenLastCalledWith(custom)
  })

  it.each(['win32', 'darwin', 'linux'] as const)(
    'preserves default relaunch arguments for ordinary %s launches',
    (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      relaunchApp('renderer-request')
      expect(appRelaunchMock).toHaveBeenCalledWith(undefined)
    }
  )
  it('passes the native restart target to Electron after recording the reason', () => {
    const options = { execPath: 'C:\\Orca\\resources\\bin\\orca.exe', args: ['restart'] }
    relaunchApp('windows-administrator', undefined, options)
    expect(appRelaunchMock).toHaveBeenCalledWith(options)
    expect(recordDurableCrashBreadcrumbMock.mock.invocationCallOrder[0]).toBeLessThan(
      appRelaunchMock.mock.invocationCallOrder[0]
    )
  })
  it('durably records the reason before scheduling the replacement process', () => {
    relaunchApp('gpu-fallback', { processReason: 'crashed', exitCode: 5 })

    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledOnce()
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('app_relaunch_requested', {
      processReason: 'crashed',
      exitCode: 5,
      reason: 'gpu-fallback'
    })
    expect(appRelaunchMock).toHaveBeenCalledOnce()
    expect(recordDurableCrashBreadcrumbMock.mock.invocationCallOrder[0]).toBeLessThan(
      appRelaunchMock.mock.invocationCallOrder[0]
    )
  })

  it('does not carry Orca PATH seeds into the replacement process', () => {
    process.env.PATH = '/seeded/newest-nvm/bin:/usr/bin'
    _setLaunchPathForTests('/usr/bin')
    let inheritedPath: string | undefined
    appRelaunchMock.mockImplementation(() => {
      inheritedPath = process.env.PATH
    })

    relaunchApp('renderer-request')

    expect(inheritedPath).toBe('/usr/bin')
    expect(process.env.PATH).toBe('/seeded/newest-nvm/bin:/usr/bin')
  })
})
