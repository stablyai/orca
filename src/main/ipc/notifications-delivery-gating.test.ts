import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getAllWindowsMock,
  getDispatchHandler,
  getOpenSystemSettingsHandler,
  handleMock,
  notificationCtorMock,
  notificationIsSupportedMock,
  notificationShowMock,
  readAuthorizationStatusMock,
  readMicActiveStatusMock,
  removeHandlerMock,
  resetNotificationDispatchMocks,
  setTrayAttentionMock,
  shellOpenExternalMock
} from './notifications-test-harness'

vi.mock('electron', async () =>
  (await import('./notifications-test-harness')).createElectronModuleMock()
)

vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
)

vi.mock('./mic-active-status', async () =>
  (await import('./notifications-test-harness')).createMicActiveStatusModuleMock()
)

vi.mock('./ui', async () =>
  (await import('./notifications-test-harness')).createTrustedUIRendererModuleMock()
)

vi.mock('../tray/system-tray', async () =>
  (await import('./notifications-test-harness')).createSystemTrayModuleMock()
)

import { registerNotificationHandlers } from './notifications'

describe('registerNotificationHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    resetNotificationDispatchMocks()
  })

  it('registers the IPC handler', async () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: true
        }
      })
    } as never)

    expect(removeHandlerMock).toHaveBeenCalledWith('notifications:dispatch')
    expect(handleMock).toHaveBeenCalledWith('notifications:dispatch', expect.any(Function))
  })

  it('opens the current macOS app notification settings entry', async () => {
    const originalPlatform = process.platform
    const originalBundleId = process.env.ORCA_DEV_MACOS_BUNDLE_ID
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    process.env.ORCA_DEV_MACOS_BUNDLE_ID = 'com.stablyai.orca.dev.fb5a47066f08'
    try {
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: true
          }
        })
      } as never)

      const handler = getOpenSystemSettingsHandler()
      handler({})

      expect(shellOpenExternalMock).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.stablyai.orca.dev.fb5a47066f08'
      )
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      if (originalBundleId === undefined) {
        delete process.env.ORCA_DEV_MACOS_BUNDLE_ID
      } else {
        process.env.ORCA_DEV_MACOS_BUNDLE_ID = originalBundleId
      }
    }
  })

  it('opens Windows notification settings', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: true
          }
        })
      } as never)

      const handler = getOpenSystemSettingsHandler()
      handler({})

      expect(shellOpenExternalMock).toHaveBeenCalledWith('ms-settings:notifications')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('suppresses notifications when disabled in settings', async () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: false,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: true
        }
      })
    } as never)

    const handler = getDispatchHandler()
    expect(await handler({}, { source: 'agent-task-complete' })).toEqual({
      delivered: false,
      reason: 'disabled'
    })
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('suppresses active-worktree notifications while Orca is focused', async () => {
    getAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        isFocused: () => true
      } as never
    ])

    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: true
        }
      })
    } as never)

    const handler = getDispatchHandler()
    expect(await handler({}, { source: 'agent-task-complete', isActiveWorktree: true })).toEqual({
      delivered: false,
      reason: 'suppressed-focus'
    })
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  describe('suppressWhileMicActive (macOS only)', () => {
    let originalPlatform: NodeJS.Platform

    beforeEach(() => {
      originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })

    it('delivers the notification but suppresses only its sound while the mic is active', async () => {
      readMicActiveStatusMock.mockResolvedValue(true)
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false,
            suppressWhileMicActive: true,
            customSoundId: 'system'
          }
        })
      } as never)

      const handler = getDispatchHandler()
      expect(await handler({}, { source: 'agent-task-complete' })).toEqual({
        delivered: true,
        soundSuppressed: true
      })
      // Why: the banner and click action must still show — only the sound is withheld.
      expect(notificationCtorMock).toHaveBeenCalledWith(expect.objectContaining({ silent: true }))
    })

    it('delivers normally with sound when the mic is inactive even with the toggle on', async () => {
      readMicActiveStatusMock.mockResolvedValue(false)
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false,
            suppressWhileMicActive: true
          }
        })
      } as never)

      const handler = getDispatchHandler()
      expect(await handler({}, { source: 'agent-task-complete' })).toEqual({ delivered: true })
    })

    it('does not suppress on an unreadable mic status (helper missing/unsupported)', async () => {
      readMicActiveStatusMock.mockResolvedValue(null)
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false,
            suppressWhileMicActive: true
          }
        })
      } as never)

      const handler = getDispatchHandler()
      expect(await handler({}, { source: 'agent-task-complete' })).toEqual({ delivered: true })
    })

    it('delivers with sound rather than waiting out a stalled mic-status helper', async () => {
      readMicActiveStatusMock.mockReturnValue(new Promise(() => {})) // never resolves
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false,
            suppressWhileMicActive: true
          }
        })
      } as never)

      const handler = getDispatchHandler()
      const dispatchPromise = handler({}, { source: 'agent-task-complete' })
      await vi.advanceTimersByTimeAsync(500)
      expect(await dispatchPromise).toEqual({ delivered: true })
    })

    it('does not check mic status when the toggle is off', async () => {
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false,
            suppressWhileMicActive: false
          }
        })
      } as never)

      const handler = getDispatchHandler()
      expect(await handler({}, { source: 'agent-task-complete' })).toEqual({ delivered: true })
      expect(readMicActiveStatusMock).not.toHaveBeenCalled()
    })

    it('does not check mic status on non-macOS even when the toggle is on', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false,
            suppressWhileMicActive: true
          }
        })
      } as never)

      const handler = getDispatchHandler()
      expect(await handler({}, { source: 'agent-task-complete' })).toEqual({ delivered: true })
      expect(readMicActiveStatusMock).not.toHaveBeenCalled()
    })
  })

  describe('minimized tray attention dot', () => {
    function registerEnabledNotifications(): void {
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: true
          }
        })
      } as never)
    }

    it('lights the tray dot for an agent completion while the window is hidden', () => {
      getAllWindowsMock.mockReturnValue([
        { isDestroyed: () => false, isVisible: () => false, isMinimized: () => false } as never
      ])
      registerEnabledNotifications()

      getDispatchHandler()({}, { source: 'agent-task-complete' })

      expect(setTrayAttentionMock).toHaveBeenCalledWith(true)
    })

    it('lights the tray dot for a terminal bell while the window is minimized', () => {
      getAllWindowsMock.mockReturnValue([
        { isDestroyed: () => false, isVisible: () => true, isMinimized: () => true } as never
      ])
      registerEnabledNotifications()

      getDispatchHandler()({}, { source: 'terminal-bell' })

      expect(setTrayAttentionMock).toHaveBeenCalledWith(true)
    })

    it('does not light the tray dot while the window is visible', () => {
      getAllWindowsMock.mockReturnValue([
        { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false } as never
      ])
      registerEnabledNotifications()

      getDispatchHandler()({}, { source: 'agent-task-complete' })

      expect(setTrayAttentionMock).not.toHaveBeenCalled()
    })

    it('does not light the tray dot for non-bell/completion sources', () => {
      getAllWindowsMock.mockReturnValue([
        { isDestroyed: () => false, isVisible: () => false, isMinimized: () => false } as never
      ])
      registerEnabledNotifications()

      getDispatchHandler()({}, { source: 'test' })

      expect(setTrayAttentionMock).not.toHaveBeenCalled()
    })
  })

  it('returns source-disabled when the specific source toggle is off', async () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: false,
          terminalBell: true,
          suppressWhenFocused: true
        }
      })
    } as never)

    const handler = getDispatchHandler()
    expect(await handler({}, { source: 'agent-task-complete' })).toEqual({
      delivered: false,
      reason: 'source-disabled'
    })
  })

  it('deduplicates repeated notifications for the same worktree', async () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false
        }
      })
    } as never)

    const handler = getDispatchHandler()
    expect(await handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: true
    })
    expect(await handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: false,
      reason: 'cooldown'
    })

    vi.advanceTimersByTime(5001)

    expect(await handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: true
    })
    expect(notificationShowMock).toHaveBeenCalledTimes(2)
  })

  it('bounds notification cooldown keys during unique worktree bursts', async () => {
    notificationIsSupportedMock.mockReturnValue(false)
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false
        }
      })
    } as never)

    const handler = getDispatchHandler()
    for (let i = 0; i < 75; i++) {
      expect(await handler({}, { source: 'terminal-bell', worktreeId: `repo::wt-${i}` })).toEqual({
        delivered: false,
        reason: 'not-supported'
      })
    }

    expect(await handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt-0' })).toEqual({
      delivered: false,
      reason: 'not-supported'
    })
    expect(await handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt-74' })).toEqual({
      delivered: false,
      reason: 'cooldown'
    })
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('deduplicates agent-task-complete and terminal-bell for the same worktree', async () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false
        }
      })
    } as never)

    const handler = getDispatchHandler()

    expect(await handler({}, { source: 'agent-task-complete', worktreeId: 'repo::wt1' })).toEqual({
      delivered: true
    })
    expect(await handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: false,
      reason: 'cooldown'
    })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
  })

  it('skips native delivery and reports blocked-by-system when macOS would swallow it', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false
          }
        })
      } as never)
      readAuthorizationStatusMock.mockResolvedValue('denied')

      const handler = getDispatchHandler()
      expect(await handler({}, { source: 'agent-task-complete' })).toEqual({
        delivered: false,
        reason: 'blocked-by-system'
      })
      // Why: a swallowed native notification would still pile up in the
      // Notification Center delivered list — skip creating it entirely.
      expect(notificationCtorMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('does not cooldown explicit test notifications', async () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false
        }
      })
    } as never)

    const handler = getDispatchHandler()

    expect(await handler({}, { source: 'test' })).toEqual({ delivered: true })
    expect(await handler({}, { source: 'test' })).toEqual({ delivered: true })
    expect(notificationShowMock).toHaveBeenCalledTimes(2)
  })
})
