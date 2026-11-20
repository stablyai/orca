import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appRelaunchMock, hasSwitchMock, exitMock, isEphemeral, prepare, fence, state } = vi.hoisted(
  () => ({
    appRelaunchMock: vi.fn(),
    exitMock: vi.fn(),
    isEphemeral: vi.fn(() => false),
    prepare: vi.fn(),
    fence: vi.fn(),
    state: { isQuitting: false },
    hasSwitchMock: vi.fn<(name: string) => boolean>(() => false)
  })
)

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    exit: exitMock,
    relaunch: appRelaunchMock,
    commandLine: { hasSwitch: hasSwitchMock }
  }
}))
vi.mock('../main-process-state', () => ({ mainProcessState: state }))
vi.mock('../cloud-startup/main-process-connector-startup', () => ({
  fenceMainProcessCloudOnQuit: fence
}))
vi.mock('../../tray/system-tray', () => ({ destroySystemTray: vi.fn() }))
vi.mock('../../updater/linux-package/appimage-runtime-identity', () => ({
  isEphemeralAppImageRuntime: isEphemeral
}))
vi.mock('./appimage-relaunch', () => ({ prepareAppImageRelaunch: prepare }))
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
  exitMock.mockReset()
  fence.mockReset()
  isEphemeral.mockReturnValue(false)
  state.isQuitting = false
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

    const { relaunchApp } = await import('./app-relaunch')
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
})

describe('renderer direct restart', () => {
  it.each([false, true])(
    'fences cloud work before exit cleanup (AppImage: %s)',
    async (appImage) => {
      const order: string[] = []
      isEphemeral.mockReturnValue(appImage)
      prepare.mockResolvedValue({
        commit: async () => {
          expect(state.isQuitting).toBe(false)
          order.push('authorize')
        },
        cancel: vi.fn()
      })
      appRelaunchMock.mockImplementation(() => order.push('authorize'))
      fence.mockImplementation(() => {
        expect(state.isQuitting).toBe(true)
        order.push('fence')
      })
      exitMock.mockImplementation(() => order.push('exit'))
      const { prepareAppRelaunch, relaunchRendererAndExit } = await import('./app-relaunch')

      const restart = await prepareAppRelaunch('renderer-request')
      await relaunchRendererAndExit(restart, async () => {
        await Promise.resolve()
        order.push('notifications closed')
      })

      expect(order).toEqual(['authorize', 'fence', 'notifications closed', 'exit'])
    }
  )

  it('leaves services live when the prepared AppImage cannot be committed', async () => {
    isEphemeral.mockReturnValue(true)
    prepare.mockResolvedValue({
      commit: async () => {
        throw new Error('AppImage moved')
      },
      cancel: vi.fn()
    })
    const cleanup = vi.fn()
    const { prepareAppRelaunch, relaunchRendererAndExit } = await import('./app-relaunch')
    const restart = await prepareAppRelaunch('renderer-request')

    await expect(relaunchRendererAndExit(restart, cleanup)).rejects.toThrow('AppImage moved')
    expect(state.isQuitting).toBe(false)
    expect(fence).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(exitMock).not.toHaveBeenCalled()
  })
})
