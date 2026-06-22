import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  browserWindowGetAllWindowsMock,
  createFromPathMock,
  dockSetIconMock,
  isMock,
  windowSetIconMock
} = vi.hoisted(() => ({
  browserWindowGetAllWindowsMock: vi.fn(),
  createFromPathMock: vi.fn(),
  dockSetIconMock: vi.fn(),
  isMock: { dev: false },
  windowSetIconMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { dock: { setIcon: dockSetIconMock } },
  BrowserWindow: { getAllWindows: browserWindowGetAllWindowsMock },
  nativeImage: { createFromPath: createFromPathMock }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('../../resources/icon.png?asset', () => ({
  default: 'classic-icon'
}))

vi.mock('../../resources/icon-dev.png?asset', () => ({
  default: 'classic-dev-icon'
}))

vi.mock('../../resources/app-icons/orca-watercolor.png?asset', () => ({
  default: 'watercolor-icon'
}))

vi.mock('../../resources/app-icons/orca-watercolor.png?asset&asarUnpack', () => ({
  default: 'watercolor-icon-unpacked'
}))

vi.mock('../../resources/app-icons/orca-blue.png?asset', () => ({
  default: 'blue-icon'
}))

vi.mock('../../resources/app-icons/orca-blue.png?asset&asarUnpack', () => ({
  default: 'blue-icon-unpacked'
}))

import { applyAppIcon, getAppIconPath, persistMacDockIcon } from './app-icon'

describe('app icon selection', () => {
  beforeEach(() => {
    browserWindowGetAllWindowsMock.mockReset()
    createFromPathMock.mockReset()
    dockSetIconMock.mockReset()
    windowSetIconMock.mockReset()
    isMock.dev = false
  })

  it('resolves classic, watercolor, blue, and invalid icon ids', () => {
    expect(getAppIconPath('classic')).toBe('classic-icon')
    expect(getAppIconPath('watercolor')).toBe('watercolor-icon')
    expect(getAppIconPath('blue')).toBe('blue-icon')
    expect(getAppIconPath('missing')).toBe('classic-icon')
  })

  it('applies the selected icon to the dock and live windows', () => {
    const image = { isEmpty: () => false }
    createFromPathMock.mockReturnValue(image)
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, setIcon: windowSetIconMock },
      { isDestroyed: () => true, setIcon: vi.fn() }
    ])

    applyAppIcon('watercolor')

    expect(createFromPathMock).toHaveBeenCalledWith('watercolor-icon')
    if (process.platform === 'darwin') {
      expect(dockSetIconMock).toHaveBeenCalledWith(image)
    } else {
      expect(dockSetIconMock).not.toHaveBeenCalled()
    }
    expect(windowSetIconMock).toHaveBeenCalledWith(image)
  })

  it('persists a custom macOS dock icon to the app bundle for inactive Dock pins', () => {
    const execFile = vi.fn()

    persistMacDockIcon('watercolor', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })

    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      expect.arrayContaining(['-e', expect.stringContaining('setIcon:image forFile:appPath')]),
      expect.objectContaining({
        env: expect.objectContaining({
          ORCA_APP_BUNDLE_PATH: '/Applications/Orca.app',
          ORCA_APP_ICON_PATH: 'watercolor-icon-unpacked'
        })
      }),
      expect.any(Function)
    )
  })

  it('clears Finder custom icon metadata when switching macOS back to the classic icon', () => {
    const execFile = vi.fn()

    persistMacDockIcon('classic', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })

    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/xattr',
      ['-d', 'com.apple.FinderInfo', '/Applications/Orca.app'],
      expect.any(Function)
    )
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/xattr',
      ['-d', 'com.apple.ResourceFork', '/Applications/Orca.app'],
      expect.any(Function)
    )
  })

  it('warns for non-benign failures when clearing Finder custom icon metadata', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execFile = vi.fn(
      (
        _file: string,
        args: string[],
        optionsOrCallback: unknown,
        callback?: (error: Error | null) => void
      ) => {
        const onComplete =
          typeof optionsOrCallback === 'function'
            ? (optionsOrCallback as (error: Error | null) => void)
            : callback
        onComplete?.(new Error(args[1] === 'com.apple.FinderInfo' ? 'No such xattr' : 'EACCES'))
      }
    )

    persistMacDockIcon('classic', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[app-icon] failed to clear macOS dock icon metadata com.apple.ResourceFork:',
      expect.any(Error)
    )

    warnSpy.mockRestore()
  })
})
