import { delimiter } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appRelaunchMock, hasSwitchMock, resolveAppImageMock, spawnMock } = vi.hoisted(() => ({
  appRelaunchMock: vi.fn(),
  hasSwitchMock: vi.fn<(name: string) => boolean>(() => false),
  resolveAppImageMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, relaunch: appRelaunchMock, commandLine: { hasSwitch: hasSwitchMock } }
}))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawnMock }))
vi.mock('../../updater/linux-package/appimage-runtime-identity', () => ({
  resolveAppImageRelaunchPath: resolveAppImageMock
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

import { relaunchApp } from './app-relaunch'
import { restartLocalTerminalsAfterElevation } from '../../windows/windows-administrator-restart'
import { _resetHydrateShellPathCache } from '../shell-environment/hydrate-shell-path'

beforeEach(() => {
  appRelaunchMock.mockReset()
  hasSwitchMock.mockReset().mockReturnValue(false)
  resolveAppImageMock.mockReset().mockResolvedValue(null)
  spawnMock.mockReset()
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
  it('passes desktop arguments intact to the outer AppImage with host search paths', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const mount = '/tmp/.mount_Orca'
    process.argv = [`${mount}/orca-ide`, '--orca-background-open', '--', "file 'name' $d", '']
    vi.stubEnv('APPDIR', mount)
    vi.stubEnv('APPIMAGE', '/opt/Orca Nightly.AppImage')
    vi.stubEnv('LD_LIBRARY_PATH', `${mount}/usr/lib${delimiter}/usr/local/lib`)
    resolveAppImageMock.mockResolvedValue('/opt/Orca Nightly.AppImage')
    spawnMock.mockReturnValue({ pid: 123, on: vi.fn(), unref: vi.fn() })

    await relaunchApp('renderer-request')

    const { args, env } = spawnMock.mock.calls[0][0]
    expect(args.slice(5)).toEqual(['/opt/Orca Nightly.AppImage', '--', "file 'name' $d", ''])
    expect(env.LD_LIBRARY_PATH).toBe('/usr/local/lib')
    expect(env.APPDIR).toBeUndefined()
    expect(appRelaunchMock).not.toHaveBeenCalled()
  })

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

    await relaunchApp('renderer-request')
    expect(nextArgs).toEqual(['--user-data-dir=C:\\Orca profile'])
    await restartLocalTerminalsAfterElevation(new AbortController().signal)
    expect(process.argv).not.toContain(flag)
    expect(nativeArgv).toContain(flag)
    await relaunchApp('profile-switch')
    expect(nextArgs).toEqual(['--user-data-dir=C:\\Orca profile'])

    const custom = { execPath: 'administrator-launcher.exe', args: ['restart', flag] }
    await relaunchApp('windows-administrator', undefined, custom)
    expect(appRelaunchMock).toHaveBeenLastCalledWith(custom)
  })
})
