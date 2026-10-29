import { describe, expect, it, vi } from 'vitest'
import { registerOrcaProtocolClient } from './orca-protocol-registration'

function fakeApp(overrides: { isPackaged?: boolean; isDefault?: boolean } = {}) {
  return {
    isPackaged: overrides.isPackaged ?? true,
    isDefaultProtocolClient: vi.fn(() => overrides.isDefault ?? false),
    setAsDefaultProtocolClient: vi.fn(() => true)
  }
}

describe('registerOrcaProtocolClient', () => {
  it('registers orca:// for a packaged Windows desktop launch', () => {
    const app = fakeApp()
    expect(registerOrcaProtocolClient(app, { platform: 'win32', desktopLaunch: true })).toBe(true)
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('orca')
  })

  it.each([
    ['macOS', { platform: 'darwin' as const, desktopLaunch: true }, {}],
    ['Linux', { platform: 'linux' as const, desktopLaunch: true }, {}],
    ['dev build', { platform: 'win32' as const, desktopLaunch: true }, { isPackaged: false }],
    ['background or serve launch', { platform: 'win32' as const, desktopLaunch: false }, {}],
    ['already registered', { platform: 'win32' as const, desktopLaunch: true }, { isDefault: true }]
  ])('leaves the handler alone on %s', (_label, options, overrides) => {
    const app = fakeApp(overrides)
    expect(registerOrcaProtocolClient(app, options)).toBe(false)
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })
})
