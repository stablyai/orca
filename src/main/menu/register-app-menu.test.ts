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

import { registerAppMenu } from './register-app-menu'

const isMac = process.platform === 'darwin'

function buildMenuOptions() {
  return {
    onCheckForUpdates: vi.fn(),
    onOpenSettings: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomReset: vi.fn(),
    onToggleStatusBar: vi.fn()
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
  beforeEach(() => {
    buildFromTemplateMock.mockReset()
    setApplicationMenuMock.mockReset()
    getFocusedWindowMock.mockReset()
    buildFromTemplateMock.mockImplementation((template) => ({ template }))
  })

  it('uses a reload menu item without a ctrl/cmd+r accelerator', () => {
    registerAppMenu(buildMenuOptions())

    expect(buildFromTemplateMock).toHaveBeenCalledTimes(1)
    const viewSubmenu = getSubmenu(getTemplate(), 'View')

    expect(viewSubmenu).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Reload' }),
        expect.objectContaining({ label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R' })
      ])
    )

    const reloadItem = viewSubmenu.find((item) => item.label === 'Reload')
    expect(reloadItem?.accelerator).toBeUndefined()
  })

  it('reloads the focused window from the view menu', () => {
    const reloadMock = vi.fn()
    const reloadIgnoringCacheMock = vi.fn()
    getFocusedWindowMock.mockReturnValue({
      webContents: {
        reload: reloadMock,
        reloadIgnoringCache: reloadIgnoringCacheMock
      }
    })

    registerAppMenu(buildMenuOptions())

    const reloadItem = getSubmenu(getTemplate(), 'View').find((item) => item.label === 'Reload')
    reloadItem?.click?.({} as never, {} as never, {} as never)

    expect(reloadMock).toHaveBeenCalledTimes(1)
    expect(reloadIgnoringCacheMock).not.toHaveBeenCalled()
  })

  it('force reloads the focused window from the view menu', () => {
    const reloadMock = vi.fn()
    const reloadIgnoringCacheMock = vi.fn()
    getFocusedWindowMock.mockReturnValue({
      webContents: {
        reload: reloadMock,
        reloadIgnoringCache: reloadIgnoringCacheMock
      }
    })

    registerAppMenu(buildMenuOptions())

    const forceReloadItem = getSubmenu(getTemplate(), 'View').find(
      (item) => item.label === 'Force Reload'
    )
    forceReloadItem?.click?.({} as never, {} as never, {} as never)

    expect(reloadIgnoringCacheMock).toHaveBeenCalledTimes(1)
    expect(reloadMock).not.toHaveBeenCalled()
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
    const expectedLabel = `Open Worktree Palette\t${isMac ? 'Cmd+J' : 'Ctrl+Shift+J'}`
    const paletteItem = viewSubmenu.find((item) => item.label === expectedLabel)

    expect(paletteItem).toBeDefined()
    expect(paletteItem?.accelerator).toBeUndefined()
  })

  it.runIf(!isMac)('puts Settings and Exit under File on Windows/Linux', () => {
    registerAppMenu(buildMenuOptions())

    const template = getTemplate()
    // Why: no redundant app-named "Orca" menu should exist on non-mac — the
    // app-menu contents (Settings, Exit, Check for Updates, About) have been
    // redistributed so users see them in File / Help instead.
    expect(template.find((item) => item.label === 'Orca')).toBeUndefined()

    const fileLabels = getSubmenu(template, 'File').map((item) => item.label)
    expect(fileLabels).toEqual(expect.arrayContaining(['Export as PDF...', 'Settings', 'Exit']))

    const helpLabels = getSubmenu(template, 'Help').map((item) => item.label)
    expect(helpLabels).toEqual(expect.arrayContaining(['Check for Updates...']))
  })

  it.runIf(isMac)('keeps the macOS app-named menu with Settings and quit roles', () => {
    registerAppMenu(buildMenuOptions())

    const template = getTemplate()
    const appSubmenu = getSubmenu(template, 'Orca')
    const appLabels = appSubmenu.map((item) => item.label)
    expect(appLabels).toEqual(expect.arrayContaining(['Check for Updates...', 'Settings']))
    // Why: on macOS File should NOT duplicate Settings/Exit — those live in
    // the system app menu, so only Export belongs under File.
    const fileLabels = getSubmenu(template, 'File').map((item) => item.label)
    expect(fileLabels).not.toContain('Settings')
    expect(fileLabels).not.toContain('Exit')
    // No Help menu on macOS — About/Check for Updates live in the app menu.
    expect(template.find((item) => item.label === 'Help')).toBeUndefined()
  })
})
