import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  restartController: vi.fn(),
  waitForDocument: vi.fn(),
  tapAccessibility: vi.fn(),
  waitForAccessibility: vi.fn()
}))

vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  activateHostedWebViewControl: mocks.activate,
  waitForVisibleHostedWebView: mocks.waitForDocument
}))

vi.mock('../../scripts/hosted-ios-emulator-accessibility.mjs', () => ({
  restartHostedIosEmulatorController: mocks.restartController,
  tapHostedIosAccessibilityControl: mocks.tapAccessibility,
  waitForHostedIosAccessibilityControl: mocks.waitForAccessibility
}))

import { verifyHostedNativeTerminalSettingsHandoff } from '../../scripts/hosted-ios-native-settings-handoff.mjs'

describe('hosted iOS native settings handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activate.mockResolvedValue(undefined)
    mocks.restartController.mockResolvedValue(undefined)
    mocks.waitForDocument
      .mockResolvedValueOnce({ href: 'orca-mobile-web://build/session/workspace' })
      .mockResolvedValueOnce({ href: 'orca-mobile-web://build/session/workspace' })
    mocks.tapAccessibility.mockResolvedValue({ x: 0.5, y: 0.7 })
    mocks.waitForAccessibility.mockResolvedValue({ x: 0.5, y: 0.2 })
  })

  it('uses a native touch and returns to the same hosted session', async () => {
    const emulator = { deviceUdid: 'simulator' }

    await expect(
      verifyHostedNativeTerminalSettingsHandoff({
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator,
        sessionDocument: { href: 'orca-mobile-web://build/session/workspace' },
        timeoutMs: 30_000
      })
    ).resolves.toEqual({
      route: 'orca-mobile-web://build/session/workspace',
      nativeTapPoint: { x: 0.5, y: 0.7 }
    })

    expect(mocks.activate).toHaveBeenCalledWith(expect.anything(), {
      kind: 'label',
      value: 'Add custom shortcut',
      reveal: true
    })
    expect(mocks.restartController).toHaveBeenCalledWith(emulator)
    expect(mocks.tapAccessibility).toHaveBeenCalledWith(emulator, 'Manage Shortcuts', 30_000)
    expect(mocks.waitForAccessibility).toHaveBeenCalledWith(
      emulator,
      'WHEN YOU LEAVE THE APP',
      30_000
    )
    expect(mocks.tapAccessibility).toHaveBeenNthCalledWith(
      2,
      emulator,
      'Back to hosted session',
      30_000
    )
  })

  it('rejects a native return that changes the hosted session route', async () => {
    mocks.waitForDocument
      .mockReset()
      .mockResolvedValueOnce({ href: 'orca-mobile-web://build/session/one' })
      .mockResolvedValueOnce({ href: 'orca-mobile-web://build/session/two' })

    await expect(
      verifyHostedNativeTerminalSettingsHandoff({
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator: {},
        sessionDocument: {},
        timeoutMs: 30_000
      })
    ).rejects.toThrow('same hosted session route')
  })
})
