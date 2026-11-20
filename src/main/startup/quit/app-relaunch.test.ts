import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appRelaunchMock, hasSwitchMock } = vi.hoisted(() => ({
  appRelaunchMock: vi.fn(),
  hasSwitchMock: vi.fn<(name: string) => boolean>(() => false)
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    exit: vi.fn(),
    relaunch: appRelaunchMock,
    commandLine: { hasSwitch: hasSwitchMock }
  }
}))
vi.mock('../../windows/windows-administrator-status', () => ({
  getWindowsAdministratorStatus: vi.fn(async () => true)
}))
vi.mock('../../daemon/providers/lifecycle/daemon-provider-restart', () => ({
  restartDaemon: vi.fn(async () => {})
}))
vi.mock('../../crash-reporting/breadcrumbs/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))

import { restartLocalTerminalsAfterElevation } from '../../windows/windows-administrator-restart'
import { _resetHydrateShellPathCache } from '../shell-environment/hydrate-shell-path'

beforeEach(() => {
  appRelaunchMock.mockReset()
  hasSwitchMock.mockReset().mockReturnValue(false)
  vi.resetModules()
})

const originalPath = process.env.PATH
const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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

    const { prepareAppRelaunch } = await import('./app-relaunch')
    await (await prepareAppRelaunch('renderer-request')).exit(0)
    expect(nextArgs).toEqual(['--user-data-dir=C:\\Orca profile'])
    await restartLocalTerminalsAfterElevation(new AbortController().signal)
    expect(process.argv).not.toContain(flag)
    expect(nativeArgv).toContain(flag)
    vi.resetModules()
    const afterConsumption = await import('./app-relaunch')
    await (await afterConsumption.prepareAppRelaunch('profile-switch')).exit(0)
    expect(nextArgs).toEqual(['--user-data-dir=C:\\Orca profile'])

    const custom = { execPath: 'administrator-launcher.exe', args: ['restart', flag] }
    vi.resetModules()
    const explicit = await import('./app-relaunch')
    await (await explicit.prepareAppRelaunch('windows-administrator', undefined, custom)).exit(0)
    expect(appRelaunchMock).toHaveBeenLastCalledWith(custom)
  })
})
