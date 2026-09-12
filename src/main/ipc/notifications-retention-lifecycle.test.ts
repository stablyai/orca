import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getAllWindowsMock,
  getDispatchHandler,
  getNotificationEventHandler,
  getNotificationOnceEventHandler,
  getTrustedUIRendererWindowMock,
  notificationCloseMock,
  notificationRemoveListenerMock,
  notificationShowMock,
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

// These cases exercise foreground behavior against Electron mocks.
beforeEach(() => {
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
  vi.stubEnv('ORCA_E2E_HEADLESS', undefined)
  vi.stubEnv('ORCA_E2E_HEADFUL', undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('registerNotificationHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    resetNotificationDispatchMocks()
  })

  it('sends an originating-pane navigation intent to the main window when a dashboard popout is open', async () => {
    const popoutSend = vi.fn()
    const popoutFocus = vi.fn()
    const webContentsSend = vi.fn()
    const restore = vi.fn()
    const show = vi.fn()
    const focus = vi.fn()
    const popoutWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
      isMinimized: () => false,
      restore: vi.fn(),
      focus: popoutFocus,
      webContents: { send: popoutSend }
    }
    const mainWindow = {
      isDestroyed: () => false,
      isFocused: () => false,
      isMinimized: () => true,
      restore,
      show,
      focus,
      webContents: { send: webContentsSend }
    }
    getAllWindowsMock.mockReturnValue([popoutWindow, mainWindow] as never)
    getTrustedUIRendererWindowMock.mockReturnValue(mainWindow)
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

    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const handler = getDispatchHandler()
    expect(
      await handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          paneKey,
          executionHostId: 'ssh:build-box'
        }
      )
    ).toEqual({ delivered: true })
    expect(vi.getTimerCount()).toBe(1)

    getNotificationEventHandler('click')()

    expect(getTrustedUIRendererWindowMock).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(popoutFocus).not.toHaveBeenCalled()
    expect(popoutSend).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('click', expect.any(Function))
    expect(webContentsSend).toHaveBeenCalledWith('ui:activateWorktree', {
      repoId: 'repo',
      worktreeId: 'repo::wt1',
      notificationPaneKey: paneKey,
      executionHostId: 'ssh:build-box'
    })
    // Why: the split focus event is what raced workspace activation; one intent replaces it.
    expect(webContentsSend).not.toHaveBeenCalledWith('ui:focusTerminal', expect.anything())
  })

  it('binds folder-workspace notifications to one navigation intent', async () => {
    const webContentsSend = vi.fn()
    const mainWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: webContentsSend }
    }
    getTrustedUIRendererWindowMock.mockReturnValue(mainWindow)
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

    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const handler = getDispatchHandler()
    expect(
      await handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'folder:folder-1',
          paneKey,
          executionHostId: 'runtime:folder-host'
        }
      )
    ).toEqual({ delivered: true })

    getNotificationEventHandler('click')()

    // Why: a folder workspace has no repoId to extract, and must still bind click-to-navigate.
    expect(webContentsSend).toHaveBeenCalledWith('ui:activateWorktree', {
      worktreeId: 'folder:folder-1',
      notificationPaneKey: paneKey,
      executionHostId: 'runtime:folder-host'
    })
    expect(webContentsSend).toHaveBeenCalledTimes(1)
  })

  it('clears the retained notification fallback timer when the native notification closes', async () => {
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
    expect(await handler({}, { source: 'agent-task-complete' })).toEqual({ delivered: true })
    expect(vi.getTimerCount()).toBe(1)

    const closeHandler = getNotificationEventHandler('close')
    closeHandler()

    expect(vi.getTimerCount()).toBe(0)
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('close', closeHandler)
  })

  it('releases retained notifications when native delivery fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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

      const handler = getDispatchHandler()
      expect(await handler({}, { source: 'agent-task-complete' })).toEqual({ delivered: true })
      expect(vi.getTimerCount()).toBe(1)

      const failedHandler = getNotificationEventHandler('failed')
      failedHandler({}, 'Application is not code signed')

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('agent-task-complete notification failed to show')
      )
      expect(vi.getTimerCount()).toBe(0)
      expect(notificationRemoveListenerMock).toHaveBeenCalledWith('failed', failedHandler)
    } finally {
      warn.mockRestore()
    }
  })

  it('closes the previous native notification when replacing the same id', async () => {
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

    const dispatchHandler = getDispatchHandler()
    expect(
      await dispatchHandler({}, { source: 'agent-task-complete', notificationId: 'agent:replace' })
    ).toEqual({ delivered: true })
    vi.advanceTimersByTime(5001)
    expect(
      await dispatchHandler({}, { source: 'agent-task-complete', notificationId: 'agent:replace' })
    ).toEqual({ delivered: true })

    expect(notificationCloseMock).toHaveBeenCalledTimes(1)
    expect(notificationShowMock).toHaveBeenCalledTimes(2)
  })

  it('confirms explicit test notifications after the native show event', async () => {
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

    const result = handler({}, { source: 'test', requireDisplayConfirmation: true })
    // Why: the darwin authorization gate resolves before the notification is
    // created, so flush microtasks before grabbing its event listeners.
    await vi.advanceTimersByTimeAsync(0)
    const showHandler = getNotificationOnceEventHandler('show')
    const failedHandler = getNotificationOnceEventHandler('failed')
    showHandler()

    await expect(result).resolves.toEqual({ delivered: true })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('show', showHandler)
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('failed', failedHandler)
  })

  it('reports not-displayed when explicit test notifications never show', async () => {
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

    const result = handler({}, { source: 'test', requireDisplayConfirmation: true })
    await vi.advanceTimersByTimeAsync(0)
    const showHandler = getNotificationOnceEventHandler('show')
    const failedHandler = getNotificationOnceEventHandler('failed')
    await vi.advanceTimersByTimeAsync(2501)

    await expect(result).resolves.toEqual({ delivered: false, reason: 'not-displayed' })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('show', showHandler)
    expect(notificationRemoveListenerMock).toHaveBeenCalledWith('failed', failedHandler)
  })
})
