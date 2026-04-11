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

function buildMenuOptions() {
  return {
    onCheckForUpdates: vi.fn(),
    onOpenSettings: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomReset: vi.fn()
  }
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
    const template = buildFromTemplateMock.mock.calls[0][0] as Electron.MenuItemConstructorOptions[]
    const viewMenu = template.find((item) => item.label === 'View')

    expect(viewMenu?.submenu).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Reload'
        }),
        expect.objectContaining({
          label: 'Force Reload',
          accelerator: 'Shift+CmdOrCtrl+R'
        })
      ])
    )

    const submenu = viewMenu?.submenu as Electron.MenuItemConstructorOptions[]
    const reloadItem = submenu.find((item) => item.label === 'Reload')
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

    const template = buildFromTemplateMock.mock.calls[0][0] as Electron.MenuItemConstructorOptions[]
    const viewMenu = template.find((item) => item.label === 'View')
    const submenu = viewMenu?.submenu as Electron.MenuItemConstructorOptions[]
    const reloadItem = submenu.find((item) => item.label === 'Reload')

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

    const template = buildFromTemplateMock.mock.calls[0][0] as Electron.MenuItemConstructorOptions[]
    const viewMenu = template.find((item) => item.label === 'View')
    const submenu = viewMenu?.submenu as Electron.MenuItemConstructorOptions[]
    const forceReloadItem = submenu.find((item) => item.label === 'Force Reload')

    forceReloadItem?.click?.({} as never, {} as never, {} as never)

    expect(reloadIgnoringCacheMock).toHaveBeenCalledTimes(1)
    expect(reloadMock).not.toHaveBeenCalled()
  })

  it('shows the worktree palette shortcut as a display-only menu hint', () => {
    registerAppMenu(buildMenuOptions())

    const template = buildFromTemplateMock.mock.calls[0][0] as Electron.MenuItemConstructorOptions[]
    const viewMenu = template.find((item) => item.label === 'View')
    const submenu = viewMenu?.submenu as Electron.MenuItemConstructorOptions[]
    const expectedLabel = `Open Worktree Palette\t${process.platform === 'darwin' ? 'Cmd+J' : 'Ctrl+Shift+J'}`
    const paletteItem = submenu.find((item) => item.label === expectedLabel)

    expect(paletteItem).toBeDefined()
    expect(paletteItem?.accelerator).toBeUndefined()
  })
})
