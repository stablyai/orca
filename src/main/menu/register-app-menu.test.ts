import { beforeEach, describe, expect, it, vi } from 'vitest'

const { buildFromTemplateMock, setApplicationMenuMock, getFocusedWindowMock } = vi.hoisted(() => ({
  buildFromTemplateMock: vi.fn(),
  setApplicationMenuMock: vi.fn(),
  getFocusedWindowMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: getFocusedWindowMock
  },
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
    setApplicationMenu: setApplicationMenuMock
  },
  app: {
    name: 'Orca'
  }
}))

import { getNextDefaultOnAppearanceSettingValue, registerAppMenu } from './register-app-menu'

const isMac = process.platform === 'darwin'

function buildMenuOptions() {
  return {
    onCheckForUpdates: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenSetupGuide: vi.fn(),
    onOpenFeatureTour: vi.fn(),
    onOpenCrashReport: vi.fn(),
    onBeforeReload: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomReset: vi.fn(),
    onToggleLeftSidebar: vi.fn(),
    onToggleRightSidebar: vi.fn(),
    onToggleAppearance: vi.fn(),
    getAppearanceState: vi.fn(() => ({
      showTasksButton: true,
      showAutomationsButton: true,
      showMobileButton: true,
      showTitlebarAppName: true,
      statusBarVisible: true
    }))
  }
}

function getTemplate(): Electron.MenuItemConstructorOptions[] {
  return buildFromTemplateMock.mock.calls[0][0] as Electron.MenuItemConstructorOptions[]
}

function getSubmenu(
  template: Electron.MenuItemConstructorOptions[],
  label: string
): Electron.MenuItemConstructorOptions[] {
  const item = template.find((entry) => entry.label === label)
  return (item?.submenu ?? []) as Electron.MenuItemConstructorOptions[]
}

describe('registerAppMenu', () => {
  it('toggles missing default-on appearance settings from visible to hidden', () => {
    expect(getNextDefaultOnAppearanceSettingValue(undefined)).toBe(false)
    expect(getNextDefaultOnAppearanceSettingValue(true)).toBe(false)
    expect(getNextDefaultOnAppearanceSettingValue(false)).toBe(true)
  })

  beforeEach(() => {
    buildFromTemplateMock.mockReset()
    setApplicationMenuMock.mockReset()
    getFocusedWindowMock.mockReset()
    buildFromTemplateMock.mockImplementation((template) => ({ template }))
  })

  it('shows reload shortcuts as policy-routed menu hints', () => {
    registerAppMenu(buildMenuOptions())

    expect(buildFromTemplateMock).toHaveBeenCalledTimes(1)
    const viewSubmenu = getSubmenu(getTemplate(), 'View')
    const expectedForceReloadLabel = `Force Reload\t${isMac ? '⌘⇧R' : 'Ctrl+Shift+R'}`

    expect(viewSubmenu).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Reload' })])
    )

    const reloadItem = viewSubmenu.find((item) => item.label === 'Reload')
    expect(reloadItem?.accelerator).toBeUndefined()
    const forceReloadItem = viewSubmenu.find((item) => item.label === expectedForceReloadLabel)
    expect(forceReloadItem).toBeDefined()
    expect(forceReloadItem?.accelerator).toBeUndefined()
  })

  it('reloads the focused window from the view menu', () => {
    const reloadMock = vi.fn()
    const reloadIgnoringCacheMock = vi.fn()
    const options = buildMenuOptions()
    options.onBeforeReload = vi.fn()
    getFocusedWindowMock.mockReturnValue({
      webContents: {
        id: 101,
        reload: reloadMock,
        reloadIgnoringCache: reloadIgnoringCacheMock
      }
    })

    registerAppMenu(options)

    const reloadItem = getSubmenu(getTemplate(), 'View').find((item) => item.label === 'Reload')
    reloadItem?.click?.({} as never, {} as never, {} as never)

    expect(reloadMock).toHaveBeenCalledTimes(1)
    expect(reloadIgnoringCacheMock).not.toHaveBeenCalled()
    expect(options.onBeforeReload).toHaveBeenCalledWith({ ignoreCache: false, webContentsId: 101 })
  })

  it('force reloads the focused window from the view menu', () => {
    const reloadMock = vi.fn()
    const reloadIgnoringCacheMock = vi.fn()
    const options = buildMenuOptions()
    options.onBeforeReload = vi.fn()
    getFocusedWindowMock.mockReturnValue({
      webContents: {
        id: 102,
        reload: reloadMock,
        reloadIgnoringCache: reloadIgnoringCacheMock
      }
    })

    registerAppMenu(options)

    const forceReloadItem = getSubmenu(getTemplate(), 'View').find((item) =>
      item.label?.startsWith('Force Reload\t')
    )
    forceReloadItem?.click?.({} as never, {} as never, {} as never)

    expect(reloadIgnoringCacheMock).toHaveBeenCalledTimes(1)
    expect(reloadMock).not.toHaveBeenCalled()
    expect(options.onBeforeReload).toHaveBeenCalledWith({ ignoreCache: true, webContentsId: 102 })
  })

  it('includes prereleases when Check for Updates is clicked with shift held', () => {
    const options = buildMenuOptions()
    registerAppMenu(options)

    // Why: Check for Updates lives under the app-name menu on macOS and
    // under Help on Windows/Linux. The click behavior must be identical
    // either way.
    const parentLabel = isMac ? 'Orca' : 'Help'
    const item = getSubmenu(getTemplate(), parentLabel).find(
      (entry) => entry.label === 'Check for Updates...'
    )

    item?.click?.({} as never, undefined as never, { shiftKey: true } as Electron.KeyboardEvent)
    item?.click?.(
      {} as never,
      undefined as never,
      { metaKey: true, shiftKey: true } as Electron.KeyboardEvent
    )
    item?.click?.({} as never, undefined as never, {} as Electron.KeyboardEvent)
    item?.click?.({} as never, undefined as never, { metaKey: true } as Electron.KeyboardEvent)

    expect(options.onCheckForUpdates.mock.calls).toEqual([
      [{ includePrerelease: true }],
      [{ includePrerelease: true }],
      [{ includePrerelease: false }],
      [{ includePrerelease: false }]
    ])
  })

  it('shows the worktree palette shortcut as a display-only menu hint', () => {
    registerAppMenu(buildMenuOptions())

    const viewSubmenu = getSubmenu(getTemplate(), 'View')
    const expectedLabel = `Open Worktree Palette\t${isMac ? '⌘J' : 'Ctrl+Shift+J'}`
    const paletteItem = viewSubmenu.find((item) => item.label === expectedLabel)

    expect(paletteItem).toBeDefined()
    expect(paletteItem?.accelerator).toBeUndefined()
  })

  it('keeps Edit > Paste on the native Electron paste role in this split', () => {
    const send = vi.fn()
    getFocusedWindowMock.mockReturnValue({ webContents: { send } })
    registerAppMenu(buildMenuOptions())

    const editSubmenu = getSubmenu(getTemplate(), 'Edit')
    const pasteItem = editSubmenu.find((item) => item.role === 'paste')

    expect(pasteItem).toBeDefined()
    expect(pasteItem?.click).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it.runIf(!isMac)('puts Settings and Exit under File on Windows/Linux', () => {
    registerAppMenu(buildMenuOptions())

    const template = getTemplate()
    // Why: no redundant app-named "Orca" menu should exist on non-mac — the
    // app-menu contents (Settings, Exit, Check for Updates, About) have been
    // redistributed so users see them in File / Help instead.
    expect(template.find((item) => item.label === 'Orca')).toBeUndefined()

    const fileLabels = getSubmenu(template, 'File').map((item) => item.label)
    expect(fileLabels).not.toContain(`Export as PDF...\t${isMac ? '⌘⇧E' : 'Ctrl+Shift+E'}`)
    expect(fileLabels[0]).toBe(`Settings\t${isMac ? '⌘,' : 'Ctrl+,'}`)
    expect(fileLabels).toEqual(
      expect.arrayContaining([`Settings\t${isMac ? '⌘,' : 'Ctrl+,'}`, 'Exit'])
    )

    const helpLabels = getSubmenu(template, 'Help').map((item) => item.label)
    expect(helpLabels).toEqual(
      expect.arrayContaining([
        'Report Crash...',
        'Getting Started with Orca',
        'Explore Orca',
        'Check for Updates...'
      ])
    )
  })

  it.runIf(isMac)('keeps the macOS app-named menu with Settings and quit roles', () => {
    registerAppMenu(buildMenuOptions())

    const template = getTemplate()
    const appSubmenu = getSubmenu(template, 'Orca')
    const appLabels = appSubmenu.map((item) => item.label)
    expect(appLabels).toEqual(
      expect.arrayContaining(['Check for Updates...', `Settings\t${isMac ? '⌘,' : 'Ctrl+,'}`])
    )
    // Why: on macOS File should NOT duplicate Settings/Exit — those live in
    // the system app menu. Without global Export, there is no File item left.
    expect(template.find((item) => item.label === 'File')).toBeUndefined()
    const helpLabels = getSubmenu(template, 'Help').map((item) => item.label)
    expect(helpLabels).toEqual([
      'Report Crash...',
      undefined,
      'Explore Orca',
      'Getting Started with Orca'
    ])
  })

  it('routes Getting Started with Orca through its callback', () => {
    const options = buildMenuOptions()
    registerAppMenu(options)

    const setupGuideItem = getSubmenu(getTemplate(), 'Help').find(
      (entry) => entry.label === 'Getting Started with Orca'
    )
    expect(setupGuideItem?.accelerator).toBeUndefined()

    const targetWindow = {} as Electron.BaseWindow
    setupGuideItem?.click?.({} as never, targetWindow, {} as Electron.KeyboardEvent)

    expect(options.onOpenSetupGuide).toHaveBeenCalledTimes(1)
    expect(options.onOpenSetupGuide).toHaveBeenCalledWith(targetWindow)
  })

  it('routes Feature tour through its callback', () => {
    const options = buildMenuOptions()
    registerAppMenu(options)

    const featureTourItem = getSubmenu(getTemplate(), 'Help').find(
      (entry) => entry.label === 'Explore Orca'
    )
    expect(featureTourItem?.accelerator).toBeUndefined()

    const targetWindow = {} as Electron.BaseWindow
    featureTourItem?.click?.({} as never, targetWindow, {} as Electron.KeyboardEvent)

    expect(options.onOpenFeatureTour).toHaveBeenCalledTimes(1)
    expect(options.onOpenFeatureTour).toHaveBeenCalledWith(targetWindow)
  })

  it('routes Report Crash through its callback', () => {
    const options = buildMenuOptions()
    registerAppMenu(options)

    const crashReportItem = getSubmenu(getTemplate(), 'Help').find(
      (entry) => entry.label === 'Report Crash...'
    )

    const targetWindow = {} as Electron.BaseWindow
    crashReportItem?.click?.({} as never, targetWindow, {} as Electron.KeyboardEvent)

    expect(options.onOpenCrashReport).toHaveBeenCalledTimes(1)
    expect(options.onOpenCrashReport).toHaveBeenCalledWith(targetWindow)
  })

  it('exposes an Appearance submenu under View with checkbox items reflecting state', () => {
    const options = buildMenuOptions()
    options.getAppearanceState.mockReturnValue({
      showTasksButton: false,
      showAutomationsButton: false,
      showMobileButton: true,
      showTitlebarAppName: true,
      statusBarVisible: true
    })
    registerAppMenu(options)

    const viewSubmenu = getSubmenu(getTemplate(), 'View')
    const appearanceEntry = viewSubmenu.find((item) => item.label === 'Appearance')
    expect(appearanceEntry).toBeDefined()

    const appearanceSubmenu = (appearanceEntry?.submenu ??
      []) as Electron.MenuItemConstructorOptions[]
    const tasksItem = appearanceSubmenu.find((item) => item.label === 'Show Tasks Button')
    expect(tasksItem?.type).toBe('checkbox')
    expect(tasksItem?.checked).toBe(false)

    const automationsItem = appearanceSubmenu.find(
      (item) => item.label === 'Show Automations Button'
    )
    expect(automationsItem?.type).toBe('checkbox')
    expect(automationsItem?.checked).toBe(false)

    const mobileItem = appearanceSubmenu.find((item) => item.label === 'Show Orca Mobile Button')
    expect(mobileItem?.type).toBe('checkbox')
    expect(mobileItem?.checked).toBe(true)

    const titlebarItem = appearanceSubmenu.find((item) => item.label === 'Show Titlebar App Name')
    expect(titlebarItem?.checked).toBe(true)

    const statusBarItem = appearanceSubmenu.find((item) => item.label === 'Show Status Bar')
    expect(statusBarItem?.checked).toBe(true)
  })

  it('routes Appearance checkbox clicks through onToggleAppearance', () => {
    const options = buildMenuOptions()
    registerAppMenu(options)

    const viewSubmenu = getSubmenu(getTemplate(), 'View')
    const appearanceSubmenu = (viewSubmenu.find((item) => item.label === 'Appearance')?.submenu ??
      []) as Electron.MenuItemConstructorOptions[]

    appearanceSubmenu
      .find((item) => item.label === 'Show Tasks Button')
      ?.click?.({} as never, {} as never, {} as never)
    appearanceSubmenu
      .find((item) => item.label === 'Show Automations Button')
      ?.click?.({} as never, {} as never, {} as never)
    appearanceSubmenu
      .find((item) => item.label === 'Show Orca Mobile Button')
      ?.click?.({} as never, {} as never, {} as never)
    appearanceSubmenu
      .find((item) => item.label === 'Show Titlebar App Name')
      ?.click?.({} as never, {} as never, {} as never)

    expect(options.onToggleAppearance).toHaveBeenCalledWith('showTasksButton')
    expect(options.onToggleAppearance).toHaveBeenCalledWith('showAutomationsButton')
    expect(options.onToggleAppearance).toHaveBeenCalledWith('showMobileButton')
    expect(options.onToggleAppearance).toHaveBeenCalledWith('showTitlebarAppName')
  })

  it('routes sidebar toggle items through their callbacks', () => {
    const options = buildMenuOptions()
    registerAppMenu(options)

    const viewSubmenu = getSubmenu(getTemplate(), 'View')
    const appearanceSubmenu = (viewSubmenu.find((item) => item.label === 'Appearance')?.submenu ??
      []) as Electron.MenuItemConstructorOptions[]

    const leftLabel = `Toggle Left Sidebar\t${isMac ? '⌘B' : 'Ctrl+B'}`
    const rightLabel = `Toggle Right Sidebar\t${isMac ? '⌘L' : 'Ctrl+L'}`

    appearanceSubmenu
      .find((item) => item.label === leftLabel)
      ?.click?.({} as never, {} as never, {} as never)
    appearanceSubmenu
      .find((item) => item.label === rightLabel)
      ?.click?.({} as never, {} as never, {} as never)

    expect(options.onToggleLeftSidebar).toHaveBeenCalledTimes(1)
    expect(options.onToggleRightSidebar).toHaveBeenCalledTimes(1)
    // Why: these entries must not bind Cmd/Ctrl+B as real accelerators
    // because before-input-event carries a TipTap-bold carve-out that the
    // menu accelerator would bypass.
    expect(appearanceSubmenu.find((item) => item.label === leftLabel)?.accelerator).toBeUndefined()
    expect(appearanceSubmenu.find((item) => item.label === rightLabel)?.accelerator).toBeUndefined()
  })
})
