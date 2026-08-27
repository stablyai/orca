import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getAllWindowsMock,
  getDismissHandler,
  getDispatchHandler,
  notificationCloseMock,
  notificationCtorMock,
  notificationIsSupportedMock,
  notificationRemoveListenerMock,
  resetNotificationDispatchMocks
} from './notifications-test-harness'

vi.mock('electron', async () =>
  (await import('./notifications-test-harness')).createElectronModuleMock()
)

vi.mock('./notification-authorization-status', async () =>
  (await import('./notifications-test-harness')).createNotificationAuthorizationModuleMock()
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

  it('uses rich formatter output for mobile notifications before the native support guard', async () => {
    notificationIsSupportedMock.mockReturnValue(false)
    const dispatchMobileNotification = vi.fn()
    registerNotificationHandlers(
      {
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: false,
            suppressWhenFocused: true
          }
        })
      } as never,
      { dispatchMobileNotification } as never
    )

    const handler = getDispatchHandler()
    expect(
      await handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'feat/notis',
          agentType: 'hermes',
          agentState: 'done',
          agentPrompt: 'Summarize the diff',
          agentLastAssistantMessage: 'The diff updates notification formatting.'
        }
      )
    ).toEqual({ delivered: false, reason: 'not-supported' })

    expect(dispatchMobileNotification).toHaveBeenCalledWith({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'feat/notis - Hermes finished',
      body: 'The diff updates notification formatting.',
      worktreeId: 'repo::wt1'
    })
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('does not dispatch mobile notifications when notifications are disabled', async () => {
    const dispatchMobileNotification = vi.fn()
    registerNotificationHandlers(
      {
        getSettings: () => ({
          notifications: {
            enabled: false,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false
          }
        })
      } as never,
      { dispatchMobileNotification } as never
    )

    const handler = getDispatchHandler()
    expect(await handler({}, { source: 'agent-task-complete', worktreeId: 'repo::wt1' })).toEqual({
      delivered: false,
      reason: 'disabled'
    })

    expect(dispatchMobileNotification).not.toHaveBeenCalled()
  })

  it('does not dispatch mobile notifications when the source is disabled', async () => {
    const dispatchMobileNotification = vi.fn()
    registerNotificationHandlers(
      {
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: false,
            terminalBell: true,
            suppressWhenFocused: false
          }
        })
      } as never,
      { dispatchMobileNotification } as never
    )

    const handler = getDispatchHandler()
    expect(await handler({}, { source: 'agent-task-complete', worktreeId: 'repo::wt1' })).toEqual({
      delivered: false,
      reason: 'source-disabled'
    })

    expect(dispatchMobileNotification).not.toHaveBeenCalled()
  })

  it('dispatches one mobile notification when the active worktree is focused on desktop', async () => {
    getAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        isFocused: () => true
      } as never
    ])
    const dispatchMobileNotification = vi.fn()
    registerNotificationHandlers(
      {
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: true
          }
        })
      } as never,
      { dispatchMobileNotification } as never
    )

    const handler = getDispatchHandler()
    const focusedNotification = {
      source: 'agent-task-complete' as const,
      worktreeId: 'repo::wt1',
      isActiveWorktree: true
    }
    expect(await handler({}, focusedNotification)).toEqual({
      delivered: false,
      reason: 'suppressed-focus'
    })
    expect(await handler({}, focusedNotification)).toEqual({
      delivered: false,
      reason: 'suppressed-focus'
    })

    expect(dispatchMobileNotification).toHaveBeenCalledTimes(1)
    expect(dispatchMobileNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete', worktreeId: 'repo::wt1' })
    )
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('does not dispatch mobile notifications for cooldown-suppressed bursts', async () => {
    const dispatchMobileNotification = vi.fn()
    registerNotificationHandlers(
      {
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false
          }
        })
      } as never,
      { dispatchMobileNotification } as never
    )

    const handler = getDispatchHandler()
    expect(await handler({}, { source: 'agent-task-complete', worktreeId: 'repo::wt1' })).toEqual({
      delivered: true
    })
    expect(await handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: false,
      reason: 'cooldown'
    })

    expect(dispatchMobileNotification).toHaveBeenCalledTimes(1)
    expect(dispatchMobileNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete', worktreeId: 'repo::wt1' })
    )
  })

  it('does not forward explicit desktop test notifications to mobile clients', async () => {
    const dispatchMobileNotification = vi.fn()
    registerNotificationHandlers(
      {
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false
          }
        })
      } as never,
      { dispatchMobileNotification } as never
    )

    const handler = getDispatchHandler()
    expect(await handler({}, { source: 'test' })).toEqual({ delivered: true })

    expect(dispatchMobileNotification).not.toHaveBeenCalled()
  })

  it('dismisses active native notifications and fans out mobile dismissal once per id', async () => {
    const dispatchMobileNotification = vi.fn()
    const dismissMobileNotification = vi.fn()
    registerNotificationHandlers(
      {
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false
          }
        })
      } as never,
      { dispatchMobileNotification, dismissMobileNotification } as never
    )

    const dispatchHandler = getDispatchHandler()
    expect(
      await dispatchHandler({}, { source: 'agent-task-complete', notificationId: 'agent:one' })
    ).toEqual({ delivered: true })

    const dismissHandler = getDismissHandler()
    expect(dismissHandler({}, ['agent:one', 'agent:one', ''])).toEqual({ dismissed: 1 })

    expect(notificationCloseMock).toHaveBeenCalledTimes(1)
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('close', expect.any(Function))
    expect(dismissMobileNotification).toHaveBeenCalledTimes(1)
    expect(dismissMobileNotification).toHaveBeenCalledWith('agent:one')
  })

  it('fans out mobile dismissal even when there is no active native notification', async () => {
    const dismissMobileNotification = vi.fn()
    registerNotificationHandlers(
      {
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false
          }
        })
      } as never,
      { dismissMobileNotification } as never
    )

    const dismissHandler = getDismissHandler()
    expect(dismissHandler({}, ['agent:missing'])).toEqual({ dismissed: 0 })

    expect(notificationCloseMock).not.toHaveBeenCalled()
    expect(dismissMobileNotification).toHaveBeenCalledWith('agent:missing')
  })
})
