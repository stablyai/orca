import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'

const mocks = vi.hoisted(() => ({
  attachGuestPolicies: vi.fn(),
  installNavigationPolicy: vi.fn(),
  isAllowedPartition: vi.fn(),
  registerPluginGuard: vi.fn()
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: { attachGuestPolicies: mocks.attachGuestPolicies }
}))
vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { isAllowedPartition: mocks.isAllowedPartition }
}))
vi.mock('../plugins/plugin-panel-navigation-guard', () => ({
  registerPluginPanelNavigationGuard: mocks.registerPluginGuard
}))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: mocks.installNavigationPolicy
}))

import { installMainWindowWebviewSecurity } from './main-window-webview-security'

describe('main window webview security', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fails closed before applying hardened guest preferences', () => {
    const handlers: Record<string, (...args: never[]) => void> = {}
    const webContents = {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers[event] = handler
      })
    }
    installMainWindowWebviewSecurity({ webContents } as never)
    mocks.isAllowedPartition.mockReturnValue(false)
    const preventDefault = vi.fn()

    handlers['will-attach-webview']?.(
      { preventDefault } as never,
      { partition: 'persist:untrusted', preload: 'attacker.js' } as never,
      { src: 'https://example.com', preload: 'attacker.js' } as never
    )

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(mocks.installNavigationPolicy).toHaveBeenCalledWith(webContents)
    expect(mocks.registerPluginGuard).toHaveBeenCalledWith(webContents)
  })

  it('removes renderer preload input and restores every hardened preference', () => {
    const handlers: Record<string, (...args: never[]) => void> = {}
    const webContents = {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers[event] = handler
      })
    }
    installMainWindowWebviewSecurity({ webContents } as never)
    mocks.isAllowedPartition.mockReturnValue(true)
    const params = { src: 'https://example.com', preload: 'attacker.js' }
    const preferences: Record<string, unknown> = {
      partition: 'persist:orca-browser',
      preload: 'attacker.js',
      preloadURL: 'attacker.js',
      sandbox: false
    }

    handlers['will-attach-webview']?.(
      { preventDefault: vi.fn() } as never,
      preferences as never,
      params as never
    )

    expect(params).not.toHaveProperty('preload')
    expect(preferences).toMatchObject({
      ...ORCA_BROWSER_GUEST_WEB_PREFERENCES,
      partition: 'persist:orca-browser',
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true
    })
    expect(preferences).not.toHaveProperty('preloadURL')
    expect(String(preferences.preload)).toMatch(/browser-window-close-preload\.js$/)
  })
})
