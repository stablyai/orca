import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  tap: vi.fn(),
  wait: vi.fn()
}))

vi.mock('../../scripts/hosted-ios-emulator-accessibility.mjs', () => ({
  tapHostedIosAccessibilityControl: mocks.tap,
  waitForHostedIosAccessibilityControlByLabelPrefix: mocks.wait
}))

import { completeHostedIosNativeOnboarding } from '../../scripts/hosted-ios-native-onboarding.mjs'

describe('hosted iOS native onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tap.mockResolvedValue({ x: 0.5, y: 0.5 })
    mocks.wait.mockResolvedValue({ x: 0.5, y: 0.5 })
  })

  it('completes the existing native decisions before entering the hosted workspace', async () => {
    mocks.wait.mockRejectedValueOnce(new Error('workspace is not visible'))
    const emulator = { deviceUdid: 'simulator' }

    await expect(
      completeHostedIosNativeOnboarding(emulator, 'mobile-rearch', 30_000)
    ).resolves.toEqual({
      sessionView: 'terminal',
      notifications: 'skipped'
    })
    expect(mocks.tap).toHaveBeenNthCalledWith(1, emulator, 'Open sessions in the terminal', 30_000)
    expect(mocks.tap).toHaveBeenNthCalledWith(2, emulator, 'Skip notifications for now', 30_000)
    expect(mocks.wait).toHaveBeenNthCalledWith(1, emulator, 'mobile-rearch', 1_000)
    expect(mocks.wait).toHaveBeenNthCalledWith(2, emulator, 'mobile-rearch', 5_000)
  })

  it('returns from an automatically opened session before selecting the workspace', async () => {
    mocks.wait
      .mockRejectedValueOnce(new Error('workspace is not visible'))
      .mockRejectedValueOnce(new Error('workspace is not visible'))
      .mockResolvedValueOnce({ x: 0.5, y: 0.5 })
    const emulator = { deviceUdid: 'simulator' }

    await completeHostedIosNativeOnboarding(emulator, 'mobile-rearch', 30_000)

    expect(mocks.tap).toHaveBeenNthCalledWith(3, emulator, 'Back to worktrees', 5_000)
    expect(mocks.wait).toHaveBeenNthCalledWith(3, emulator, 'mobile-rearch', 30_000)
  })

  it('preserves an already completed native route', async () => {
    const emulator = { deviceUdid: 'simulator' }

    await expect(
      completeHostedIosNativeOnboarding(emulator, 'mobile-rearch', 30_000)
    ).resolves.toEqual({
      sessionView: 'retained',
      notifications: 'retained'
    })
    expect(mocks.wait).toHaveBeenCalledWith(emulator, 'mobile-rearch', 1_000)
    expect(mocks.tap).not.toHaveBeenCalled()
  })
})
