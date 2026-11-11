import type * as WslAvailability from '../wsl/discovery/wsl-availability'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AppRelaunch from '../startup/quit/app-relaunch'

const {
  handlers,
  appExitMock,
  appQuitMock,
  appRelaunchMock,
  spawnMock,
  destroySystemTrayMock,
  rebuildSystemTrayMenuMock,
  rebuildAppMenuMock,
  getSystemLanguageDetectionMock,
  setMainUiLanguageMock,
  relaunchAppMock,
  showOpenDialogMock,
  trustFloatingWorkspaceDirectoryMock,
  registerRendererShutdownCheckpointHandlerMock,
  registerMacKeyboardLayoutChangeNotificationsMock,
  prepareWindowsAdministratorRestartMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  appExitMock: vi.fn(),
  appQuitMock: vi.fn(),
  appRelaunchMock: vi.fn(),
  spawnMock: vi.fn(),
  destroySystemTrayMock: vi.fn(),
  rebuildSystemTrayMenuMock: vi.fn(),
  rebuildAppMenuMock: vi.fn(),
  getSystemLanguageDetectionMock: vi.fn(),
  setMainUiLanguageMock: vi.fn(),
  relaunchAppMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  trustFloatingWorkspaceDirectoryMock: vi.fn(),
  registerRendererShutdownCheckpointHandlerMock: vi.fn(),
  registerMacKeyboardLayoutChangeNotificationsMock: vi.fn(),
  prepareWindowsAdministratorRestartMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

vi.mock('electron', () => ({
  app: {
    exit: appExitMock,
    getAppPath: vi.fn(() => '/test/app'),
    isPackaged: false,
    quit: appQuitMock,
    relaunch: appRelaunchMock
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null)
  },
  dialog: {
    showOpenDialog: showOpenDialogMock
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../tray/system-tray', () => ({
  destroySystemTray: destroySystemTrayMock,
  rebuildSystemTrayMenu: rebuildSystemTrayMenuMock
}))

vi.mock('../menu/register-app-menu', () => ({ rebuildAppMenu: rebuildAppMenuMock }))
vi.mock('../i18n/system-language', () => ({
  getSystemLanguageDetection: getSystemLanguageDetectionMock
}))
vi.mock('../i18n/main-i18n', () => ({ setMainUiLanguage: setMainUiLanguageMock }))

vi.mock('../startup/quit/app-relaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof AppRelaunch>()),
  relaunchApp: relaunchAppMock
}))

vi.mock('../windows/windows-administrator-restart', () => ({
  prepareWindowsAdministratorRestart: prepareWindowsAdministratorRestartMock
}))

vi.mock('./floating-workspace-directory', () => ({
  ensureDefaultFloatingWorkspacePath: vi.fn(),
  trustFloatingWorkspaceDirectory: trustFloatingWorkspaceDirectoryMock,
  resolveFloatingTerminalCwd: vi.fn()
}))

vi.mock('./renderer-shutdown-checkpoint', () => ({
  registerRendererShutdownCheckpointHandler: registerRendererShutdownCheckpointHandlerMock
}))

vi.mock('./macos-keyboard-layout-change-notifications', () => ({
  registerMacKeyboardLayoutChangeNotifications: registerMacKeyboardLayoutChangeNotificationsMock
}))

const windowsProbes = vi.hoisted(() => ({
  isWslAvailableAsync: vi.fn(async () => true),
  listWslDistros: vi.fn(() => ['Ubuntu']),
  listWslDistrosAsync: vi.fn(async () => ['Ubuntu']),
  isPwshAvailable: vi.fn(() => true),
  isPwshAvailableAsync: vi.fn(async () => true)
}))

vi.mock('../wsl/discovery/wsl-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof WslAvailability>()),
  ...(await (() => ({
    isWslAvailableAsync: windowsProbes.isWslAvailableAsync
  }))())
}))
vi.mock('../wsl/discovery/distro-catalog', () => ({
  listWslDistros: windowsProbes.listWslDistros,
  listWslDistrosAsync: windowsProbes.listWslDistrosAsync
}))

vi.mock('../pty/shell-startup/pwsh', () => ({
  isPwshAvailable: windowsProbes.isPwshAvailable,
  isPwshAvailableAsync: windowsProbes.isPwshAvailableAsync
}))

import { registerAppHandlers } from './app'

describe('registerAppHandlers', () => {
  const originalPlatform = process.platform
  // Fake child PIDs must never target a live process group on timeout.
  let processKillSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    handlers.clear()
    appExitMock.mockReset()
    appQuitMock.mockReset()
    appRelaunchMock.mockReset()
    spawnMock.mockReset()
    destroySystemTrayMock.mockReset()
    rebuildSystemTrayMenuMock.mockReset()
    rebuildAppMenuMock.mockReset()
    getSystemLanguageDetectionMock.mockReset()
    setMainUiLanguageMock.mockReset()
    relaunchAppMock.mockReset()
    relaunchAppMock.mockImplementation(() => appRelaunchMock())
    prepareWindowsAdministratorRestartMock.mockReset()
    showOpenDialogMock.mockReset()
    trustFloatingWorkspaceDirectoryMock.mockReset()
    registerRendererShutdownCheckpointHandlerMock.mockReset()
    registerMacKeyboardLayoutChangeNotificationsMock.mockReset()
    for (const probe of Object.values(windowsProbes)) {
      probe.mockClear()
    }
    processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  afterEach(() => {
    processKillSpy.mockRestore()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('checkpoints before scheduling the native administrator restart and quits normally', async () => {
    const plan = { execPath: 'C:\\Orca\\resources\\bin\\orca.exe', args: ['restart'] }
    prepareWindowsAdministratorRestartMock.mockReturnValue(plan)
    let finishCleanup!: () => void
    const onBeforeRelaunch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler never reads the store.
    registerAppHandlers({} as never, { onBeforeRelaunch })
    const pending = Promise.resolve(handlers.get('app:restartAsAdministrator')?.(null))
    await vi.advanceTimersByTimeAsync(150)
    expect(relaunchAppMock).not.toHaveBeenCalled()
    finishCleanup()
    await pending
    await vi.advanceTimersByTimeAsync(150)
    expect(relaunchAppMock).toHaveBeenCalledWith('windows-administrator', undefined, plan)
    expect(appQuitMock).toHaveBeenCalledOnce()
    expect(appExitMock).not.toHaveBeenCalled()
  })

  it('keeps the desktop open if the native restart is unavailable', async () => {
    prepareWindowsAdministratorRestartMock.mockImplementation(() => {
      throw new Error('Unavailable')
    })
    const onBeforeRelaunch = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler never reads the store.
    registerAppHandlers({} as never, { onBeforeRelaunch })
    await expect(handlers.get('app:restartAsAdministrator')?.(null)).rejects.toThrow('Unavailable')
    await vi.advanceTimersByTimeAsync(150)
    expect(onBeforeRelaunch).not.toHaveBeenCalled()
    expect(relaunchAppMock).not.toHaveBeenCalled()
    expect(appQuitMock).not.toHaveBeenCalled()
  })

  it('waits for pre-relaunch cleanup before exiting', async () => {
    let finishCleanup!: () => void
    const onBeforeRelaunch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    registerAppHandlers({} as never, { onBeforeRelaunch })

    const relaunchPromise = Promise.resolve(handlers.get('app:relaunch')?.(null))

    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(150)
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(appExitMock).not.toHaveBeenCalled()

    finishCleanup()
    await relaunchPromise
    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('runs exit-only cleanup after pre-relaunch cleanup on relaunch, never on restart', async () => {
    let finishExitCleanup!: () => void
    const onBeforeRelaunch = vi.fn()
    const onBeforeRelaunchExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishExitCleanup = resolve
        })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: relaunch and restart never read the store.
    registerAppHandlers({} as never, { onBeforeRelaunch, onBeforeRelaunchExit })

    await handlers.get('app:restart')?.(null)
    await vi.advanceTimersByTimeAsync(150)
    expect(onBeforeRelaunchExit).not.toHaveBeenCalled()

    const relaunchPromise = Promise.resolve(handlers.get('app:relaunch')?.(null))
    await vi.advanceTimersByTimeAsync(0)
    expect(onBeforeRelaunchExit).toHaveBeenCalledOnce()
    expect(onBeforeRelaunch.mock.invocationCallOrder.at(-1)).toBeLessThan(
      onBeforeRelaunchExit.mock.invocationCallOrder[0]
    )
    await vi.advanceTimersByTimeAsync(150)
    expect(appExitMock).not.toHaveBeenCalled()

    finishExitCleanup()
    await relaunchPromise
    await vi.advanceTimersByTimeAsync(150)
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('waits for pre-relaunch cleanup before restarting through the normal pipeline', async () => {
    let finishCleanup!: () => void
    const onBeforeRelaunch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    registerAppHandlers({} as never, { onBeforeRelaunch })

    const restartPromise = Promise.resolve(handlers.get('app:restart')?.(null))

    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(150)
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(appQuitMock).not.toHaveBeenCalled()

    finishCleanup()
    await restartPromise
    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledTimes(1)
    expect(appQuitMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).not.toHaveBeenCalled()
  })

  // Renderer capability refreshes must not block the main loop on synchronous wsl.exe/pwsh.exe probes.
})
