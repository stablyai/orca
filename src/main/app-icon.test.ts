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

vi.mock('../../resources/app-icons/orca-blue.png?asset', () => ({
  default: 'blue-icon'
}))

import { applyAppIcon, getAppIconPath } from './app-icon'

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
})
