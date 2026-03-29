import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  removeHandlerMock,
  handleMock,
  notificationShowMock,
  notificationCtorMock,
  notificationIsSupportedMock,
  getAllWindowsMock
} = vi.hoisted(() => {
  const removeHandlerMock = vi.fn()
  const handleMock = vi.fn()
  const notificationShowMock = vi.fn()
  const notificationCtorMock = vi.fn(function () {
    return {
      show: notificationShowMock
    }
  })
  const notificationIsSupportedMock = vi.fn(() => true)
  const getAllWindowsMock = vi.fn(() => [])
  return {
    removeHandlerMock,
    handleMock,
    notificationShowMock,
    notificationCtorMock,
    notificationIsSupportedMock,
    getAllWindowsMock
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  Notification: Object.assign(notificationCtorMock, {
    isSupported: notificationIsSupportedMock
  }),
  BrowserWindow: {
    getAllWindows: getAllWindowsMock
  }
}))

import { registerNotificationHandlers } from './notifications'

describe('registerNotificationHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    removeHandlerMock.mockReset()
    handleMock.mockReset()
    notificationCtorMock.mockClear()
    notificationShowMock.mockClear()
    notificationIsSupportedMock.mockReset()
    notificationIsSupportedMock.mockReturnValue(true)
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([])
  })

  it('registers the IPC handler', () => {
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

  it('suppresses notifications when disabled in settings', () => {
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

    const handler = handleMock.mock.calls[0][1] as (event: unknown, args: unknown) => unknown
    expect(handler({}, { source: 'agent-task-complete' })).toEqual({ delivered: false })
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('suppresses active-worktree notifications while Orca is focused', () => {
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

    const handler = handleMock.mock.calls[0][1] as (event: unknown, args: unknown) => unknown
    expect(handler({}, { source: 'agent-task-complete', isActiveWorktree: true })).toEqual({
      delivered: false
    })
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('delivers a notification when the event is allowed', () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: false,
          suppressWhenFocused: true
        }
      })
    } as never)

    const handler = handleMock.mock.calls[0][1] as (event: unknown, args: unknown) => unknown
    expect(
      handler({}, { source: 'agent-task-complete', repoLabel: 'orca', worktreeLabel: 'feat/notis' })
    ).toEqual({ delivered: true })
    expect(notificationCtorMock).toHaveBeenCalledWith({
      title: 'Task complete in feat/notis',
      body: 'orca'
    })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
  })

  it('deduplicates repeated notifications for the same worktree and source', () => {
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

    const handler = handleMock.mock.calls[0][1] as (event: unknown, args: unknown) => unknown
    expect(handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: true
    })
    expect(handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: false
    })

    vi.advanceTimersByTime(5001)

    expect(handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: true
    })
    expect(notificationShowMock).toHaveBeenCalledTimes(2)
  })
})
