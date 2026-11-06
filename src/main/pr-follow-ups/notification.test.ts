import { describe, expect, it, vi } from 'vitest'
import { createNotificationDeliveryService } from '../notifications/notification-delivery-service'

// Exercise delivery admission without Electron or a native banner.
describe('automatic follow-up notifications', () => {
  it('suppresses only the desktop banner while focused and still dispatches the automatic start to phones', async () => {
    let focused = true
    const dispatchMobileNotification = vi.fn()
    const deliverNative = vi.fn(() => ({ delivered: true }))
    const service = createNotificationDeliveryService({
      readNotificationSettings: () => ({
        enabled: true,
        agentTaskComplete: true,
        agentNeedsInput: true,
        terminalBell: false,
        suppressWhenFocused: false,
        customSoundId: 'system',
        customSoundPath: null,
        customSoundVolume: 1,
        mutedNotificationSourceIds: [],
        notifyHiddenWorkspaces: true
      }),
      findActiveWindow: () => ({ isFocused: () => focused }) as never,
      isWindowVisible: () => true,
      setTrayAttention: vi.fn(),
      isNotificationSupported: () => true,
      dispatchMobileNotification,
      readAuthorizationStatus: async () => 'authorized',
      recordDeliveryOutcome: vi.fn(),
      deliverNative,
      platform: 'linux',
      now: () => 1700000000000
    })
    expect(
      await service.dispatch({
        source: 'pr-followup-started',
        isActiveWorktree: false,
        terminalTitle: 'codex',
        prNumber: 42,
        failedCheckCount: 2,
        worktreeLabel: 'fix-checks'
      })
    ).toEqual({ delivered: false, reason: 'suppressed-focus' })
    expect(deliverNative).not.toHaveBeenCalled()
    expect(dispatchMobileNotification).toHaveBeenCalledOnce()
    focused = false
    expect(
      await service.dispatch({ source: 'pr-followup-started', isActiveWorktree: false })
    ).toEqual({ delivered: true })
    expect(deliverNative).toHaveBeenCalledOnce()
  })
})
