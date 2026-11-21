import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  Menu: {},
  Tray: vi.fn(),
  nativeImage: {},
  nativeTheme: {}
}))
vi.mock('../window/desktop-integration/app-icon', () => ({ createAppIconImage: vi.fn() }))

import { createSystemTray, setMacMenuBarIconVisible } from './system-tray'

describe('background launch tray suppression', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('keeps automation out of the tray, including later settings visibility updates', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    const options = {
      appIcon: 'classic',
      isDevInstance: true,
      devInstanceLabel: 'validation',
      onOpen: vi.fn(),
      onOpenSettings: vi.fn(),
      onCheckForUpdates: vi.fn(),
      onQuit: vi.fn()
    }
    expect(createSystemTray(options)).toBeNull()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(setMacMenuBarIconVisible(true, options)).toBeNull()
  })
})
