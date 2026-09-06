import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  dismissDeveloperMenu,
  rotateEmulator,
  tapControl,
  tapControlByPrefix,
  typeText,
  waitByPrefix
} = vi.hoisted(() => ({
  dismissDeveloperMenu: vi.fn(),
  rotateEmulator: vi.fn(),
  tapControl: vi.fn(),
  tapControlByPrefix: vi.fn(),
  typeText: vi.fn(),
  waitByPrefix: vi.fn()
}))

vi.mock('../../scripts/emulator-developer-menu-dismissal.mjs', () => ({
  dismissEmulatorDeveloperMenuIfPresent: dismissDeveloperMenu
}))
vi.mock('../../scripts/hosted-ios-emulator-accessibility.mjs', () => ({
  rotateHostedIosEmulator: rotateEmulator,
  tapHostedIosAccessibilityControl: tapControl,
  tapHostedIosAccessibilityControlByLabelPrefix: tapControlByPrefix,
  typeHostedIosText: typeText,
  waitForHostedIosAccessibilityControl: vi.fn(),
  waitForHostedIosAccessibilityControlByLabelPrefix: waitByPrefix
}))

import { openNativeAgentHistoryBaseline } from '../../scripts/hosted-ios-agent-history-parity.mjs'

describe('native Agent History baseline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  it('dismisses a reopened Expo developer overlay before navigating', async () => {
    const emulator = { deviceUdid: 'simulator' }
    const opened = openNativeAgentHistoryBaseline({
      emulator,
      expectedWorkspace: 'mobile-rearch',
      timeoutMs: 30_000
    })

    await vi.runAllTimersAsync()
    await opened

    expect(dismissDeveloperMenu).toHaveBeenCalledWith(emulator)
    expect(rotateEmulator).toHaveBeenCalledWith(emulator, 'portrait')
    expect(tapControlByPrefix).toHaveBeenNthCalledWith(1, emulator, 'mobile-rearch', 30_000)
    expect(tapControl).toHaveBeenCalledWith(emulator, 'More session actions', 30_000)
    expect(tapControlByPrefix).toHaveBeenNthCalledWith(2, emulator, 'Agent History', 30_000)
    expect(tapControl).toHaveBeenCalledWith(emulator, 'Search sessions, repo:, path:', 30_000)
    expect(typeText).toHaveBeenCalledWith(emulator, 'hybrid agent history fixture')
    expect(waitByPrefix).toHaveBeenCalledWith(emulator, 'Hybrid Agent History Fixture', 30_000)
    expect(tapControl).toHaveBeenCalledWith(emulator, 'Agent Session History', 30_000)
    expect(rotateEmulator.mock.invocationCallOrder[0]).toBeLessThan(
      dismissDeveloperMenu.mock.invocationCallOrder[0]
    )
    expect(dismissDeveloperMenu.mock.invocationCallOrder[0]).toBeLessThan(
      tapControlByPrefix.mock.invocationCallOrder[0]
    )
  })
})
