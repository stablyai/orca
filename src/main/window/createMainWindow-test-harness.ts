import { vi } from 'vitest'
import type { Mock } from 'vitest'

/** Loose spy signature: these stand in for electron APIs the suites only assert calls on. */
export type MainWindowSpy = Mock<(...args: unknown[]) => unknown>

export const menuPopupMock: MainWindowSpy = vi.fn()
export const notificationShowMock: MainWindowSpy = vi.fn()
/** Constructor spy: suites read the options object back off `mock.calls`. */
export const browserWindowMock: Mock<
  (options: Electron.BrowserWindowConstructorOptions) => unknown
> = vi.fn()
export const openExternalMock: MainWindowSpy = vi.fn()
export const attachGuestPoliciesMock: MainWindowSpy = vi.fn()
export const buildFromTemplateMock: Mock<(...args: unknown[]) => { popup: MainWindowSpy }> = vi.fn(
  () => ({ popup: menuPopupMock })
)
export const notificationMock: Mock<(...args: unknown[]) => { show: MainWindowSpy }> = vi.fn(
  function () {
    return { show: notificationShowMock }
  }
)
export const powerMonitorOnMock: MainWindowSpy = vi.fn()
export const powerMonitorRemoveListenerMock: MainWindowSpy = vi.fn()
export const isMock = { dev: false }
export const macosTahoeMock = { value: false }

type IpcMainMock = {
  on: MainWindowSpy
  removeListener: MainWindowSpy
  handle: MainWindowSpy
  removeHandler: MainWindowSpy
}

const ipcMainMock: IpcMainMock = {
  on: vi.fn(),
  removeListener: vi.fn(),
  handle: vi.fn(),
  removeHandler: vi.fn()
}

export type ElectronModuleMock = {
  app: { on: MainWindowSpy; removeListener: MainWindowSpy }
  BrowserWindow: typeof browserWindowMock
  ipcMain: IpcMainMock
  Menu: { buildFromTemplate: typeof buildFromTemplateMock }
  Notification: typeof notificationMock
  nativeTheme: { shouldUseDarkColors: boolean }
  powerMonitor: { on: MainWindowSpy; removeListener: MainWindowSpy }
  screen: {
    getPrimaryDisplay: () => { workAreaSize: { width: number; height: number } }
    getDisplayMatching: () => { scaleFactor: number }
  }
  shell: { openExternal: MainWindowSpy }
}

export type BrowserManagerModuleMock = {
  browserManager: {
    attachGuestPolicies: MainWindowSpy
    setDictationShortcutForwardingPredicate: MainWindowSpy
  }
}

// Why: vi.mock factories are hoisted per test file, so each file calls these builders instead of
// re-declaring the shared electron surface.
export function electronModuleMock(): ElectronModuleMock {
  return {
    app: { on: vi.fn(), removeListener: vi.fn() },
    BrowserWindow: browserWindowMock,
    ipcMain: ipcMainMock,
    Menu: { buildFromTemplate: buildFromTemplateMock },
    Notification: notificationMock,
    nativeTheme: { shouldUseDarkColors: false },
    powerMonitor: { on: powerMonitorOnMock, removeListener: powerMonitorRemoveListenerMock },
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }),
      getDisplayMatching: () => ({ scaleFactor: 2 })
    },
    shell: { openExternal: openExternalMock }
  }
}

export function electronToolkitUtilsMock() {
  return {
    is: isMock
  }
}

export function macosTahoeReleaseMock() {
  return {
    isMacosTahoeOrNewer: vi.fn(() => macosTahoeMock.value)
  }
}

export function appIconMock() {
  return {
    getAppIconPath: vi.fn(() => 'icon')
  }
}

export function browserManagerMock(): BrowserManagerModuleMock {
  return {
    browserManager: {
      attachGuestPolicies: attachGuestPoliciesMock,
      setDictationShortcutForwardingPredicate: vi.fn()
    }
  }
}

export function resetMainWindowMocks(): void {
  browserWindowMock.mockReset()
  openExternalMock.mockReset()
  attachGuestPoliciesMock.mockReset()
  buildFromTemplateMock.mockClear()
  menuPopupMock.mockClear()
  notificationMock.mockClear()
  notificationShowMock.mockClear()
  powerMonitorOnMock.mockReset()
  powerMonitorRemoveListenerMock.mockReset()
  isMock.dev = false
  macosTahoeMock.value = false
  ipcMainMock.on.mockReset()
  ipcMainMock.removeListener.mockReset()
  ipcMainMock.handle.mockReset()
  ipcMainMock.removeHandler.mockReset()
}

export function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}
