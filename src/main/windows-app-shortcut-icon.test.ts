import { describe, expect, it, vi } from 'vitest'

import { updateWindowsAppShortcutIcon } from './windows-app-shortcut-icon'

describe('Windows app shortcut icon', () => {
  it('updates Orca-owned shortcuts without changing their launch identity', () => {
    const programsPath = 'D:\\Redirected Start Menu\\Programs'
    const getProgramsPath = vi.fn(() => programsPath)
    const readShortcutLink = vi.fn((shortcutPath: string) => ({
      target: 'C:\\Program Files\\Orca\\Orca.exe',
      args: shortcutPath.includes('Desktop') ? '--desktop' : '',
      appUserModelId: 'com.example.existing-orca',
      cwd: 'C:\\Program Files\\Orca',
      description: 'Orca'
    }))
    const writeShortcutLink = vi.fn(() => true)

    const result = updateWindowsAppShortcutIcon('C:\\icons\\orca-watercolor.ico', {
      appDataPath: 'C:\\Users\\Test\\AppData\\Roaming',
      appName: 'Orca',
      desktopPath: 'C:\\Users\\Test\\Desktop',
      executablePath: 'C:\\Program Files\\Orca\\Orca.exe',
      isPackaged: true,
      pathExists: () => true,
      platform: 'win32',
      getProgramsPath,
      readShortcutLink,
      writeShortcutLink
    })

    expect(result).toEqual({
      failedPaths: [],
      updatedPaths: [`${programsPath}\\Orca.lnk`, 'C:\\Users\\Test\\Desktop\\Orca.lnk']
    })
    expect(getProgramsPath).toHaveBeenCalledOnce()
    expect(writeShortcutLink).toHaveBeenNthCalledWith(1, `${programsPath}\\Orca.lnk`, 'update', {
      appUserModelId: 'com.example.existing-orca',
      args: '',
      cwd: 'C:\\Program Files\\Orca',
      description: 'Orca',
      icon: 'C:\\icons\\orca-watercolor.ico',
      iconIndex: 0,
      target: 'C:\\Program Files\\Orca\\Orca.exe'
    })
    expect(writeShortcutLink).toHaveBeenNthCalledWith(
      2,
      'C:\\Users\\Test\\Desktop\\Orca.lnk',
      'update',
      expect.objectContaining({
        appUserModelId: 'com.example.existing-orca',
        args: '--desktop',
        icon: 'C:\\icons\\orca-watercolor.ico',
        iconIndex: 0,
        target: 'C:\\Program Files\\Orca\\Orca.exe'
      })
    )
  })

  it('does not update same-named shortcuts that target another application', () => {
    const writeShortcutLink = vi.fn(() => true)

    const result = updateWindowsAppShortcutIcon('C:\\icons\\orca-blue.ico', {
      appDataPath: 'C:\\Users\\Test\\AppData\\Roaming',
      appName: 'Orca',
      desktopPath: 'C:\\Users\\Test\\Desktop',
      executablePath: 'C:\\Program Files\\Orca\\Orca.exe',
      getProgramsPath: () =>
        'C:\\Users\\Test\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
      isPackaged: true,
      pathExists: () => true,
      platform: 'win32',
      readShortcutLink: vi.fn(() => ({ target: 'C:\\Other App\\Orca.exe' })),
      writeShortcutLink
    })

    expect(result).toEqual({ failedPaths: [], updatedPaths: [] })
    expect(writeShortcutLink).not.toHaveBeenCalled()
  })

  it('does not edit installed shortcuts from development or another platform', () => {
    const writeShortcutLink = vi.fn(() => true)
    const baseOptions = {
      appDataPath: 'C:\\Users\\Test\\AppData\\Roaming',
      appName: 'Orca',
      desktopPath: 'C:\\Users\\Test\\Desktop',
      getProgramsPath: () =>
        'C:\\Users\\Test\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
      pathExists: () => true,
      readShortcutLink: vi.fn(() => ({ target: 'C:\\Orca.exe' })),
      writeShortcutLink
    }

    expect(
      updateWindowsAppShortcutIcon('C:\\icons\\orca-blue.ico', {
        ...baseOptions,
        isPackaged: false,
        platform: 'win32'
      })
    ).toEqual({ failedPaths: [], updatedPaths: [] })
    expect(
      updateWindowsAppShortcutIcon('C:\\icons\\orca-blue.ico', {
        ...baseOptions,
        isPackaged: true,
        platform: 'darwin'
      })
    ).toEqual({ failedPaths: [], updatedPaths: [] })
    expect(writeShortcutLink).not.toHaveBeenCalled()
  })

  it('skips missing shortcuts and reports an update failure without aborting settings', () => {
    const startMenuShortcut =
      'C:\\Users\\Test\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Orca.lnk'
    const writeShortcutLink = vi.fn(() => false)

    const result = updateWindowsAppShortcutIcon('C:\\icons\\orca-blue.ico', {
      appDataPath: 'C:\\Users\\Test\\AppData\\Roaming',
      appName: 'Orca',
      desktopPath: 'C:\\Users\\Test\\Desktop',
      executablePath: 'C:\\Orca.exe',
      getProgramsPath: () =>
        'C:\\Users\\Test\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
      isPackaged: true,
      pathExists: (shortcutPath) => shortcutPath === startMenuShortcut,
      platform: 'win32',
      readShortcutLink: vi.fn(() => ({ target: 'C:\\Orca.exe' })),
      writeShortcutLink
    })

    expect(result).toEqual({ failedPaths: [startMenuShortcut], updatedPaths: [] })
  })
})
