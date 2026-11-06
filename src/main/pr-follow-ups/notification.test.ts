import { describe, expect, it, vi } from 'vitest'
import { createNotificationDeliveryService } from '../notifications/notification-delivery-service'

// Exercise delivery admission without Electron or a native banner.
describe('automatic follow-up notifications', () => {
  it('suppresses an automatic start in any focused workspace, even when normal focus suppression is off', async () => {
    let focused = true
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
      dispatchMobileNotification: null,
      readAuthorizationStatus: async () => 'authorized',
      recordDeliveryOutcome: vi.fn(),
      deliverNative,
      platform: 'linux',
      now: () => 1700000000000
    })
    expect(
      await service.dispatch({ source: 'pr-followup-started', isActiveWorktree: false })
    ).toEqual({ delivered: false, reason: 'suppressed-focus' })
    expect(deliverNative).not.toHaveBeenCalled()
    focused = false
    expect(
      await service.dispatch({ source: 'pr-followup-started', isActiveWorktree: false })
    ).toEqual({ delivered: true })
    expect(deliverNative).toHaveBeenCalledOnce()
  })
})
