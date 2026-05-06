/* eslint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  removeHandlerMock,
  handleMock,
  notificationShowMock,
  notificationCloseMock,
  notificationOnMock,
  notificationCtorMock,
  notificationIsSupportedMock,
  getAllWindowsMock
} = vi.hoisted(() => {
  const removeHandlerMock = vi.fn()
  const handleMock = vi.fn()
  const notificationShowMock = vi.fn()
  const notificationCloseMock = vi.fn()
  const notificationOnMock = vi.fn()
  const notificationCtorMock = vi.fn(function () {
    return {
      show: notificationShowMock,
      close: notificationCloseMock,
      on: notificationOnMock
    }
  })
  const notificationIsSupportedMock = vi.fn(() => true)
  const getAllWindowsMock = vi.fn(() => [])
  return {
    removeHandlerMock,
    handleMock,
    notificationShowMock,
    notificationCloseMock,
    notificationOnMock,
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
  },
  app: {
    focus: vi.fn()
  },
  shell: {
    openExternal: vi.fn()
  }
}))

import {
  registerNotificationHandlers,
  triggerStartupNotificationRegistration
} from './notifications'

describe('registerNotificationHandlers', () => {
  let tempDir: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    tempDir = mkdtempSync(join(tmpdir(), 'orca-notification-test-'))
    removeHandlerMock.mockReset()
    handleMock.mockReset()
    notificationCtorMock.mockClear()
    notificationShowMock.mockClear()
    notificationCloseMock.mockClear()
    notificationOnMock.mockClear()
    notificationIsSupportedMock.mockReset()
    notificationIsSupportedMock.mockReturnValue(true)
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([])
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function getDispatchHandler(): (event: unknown, args: unknown) => unknown {
    const call = handleMock.mock.calls.find((c: unknown[]) => c[0] === 'notifications:dispatch')
    if (!call) {
      throw new Error('notifications:dispatch handler not registered')
    }
    return call[1] as (event: unknown, args: unknown) => unknown
  }

  function getLoadSoundHandler(): (event: unknown) => Promise<unknown> {
    const call = handleMock.mock.calls.find((c: unknown[]) => c[0] === 'notifications:loadSound')
    if (!call) {
      throw new Error('notifications:loadSound handler not registered')
    }
    return call[1] as (event: unknown) => Promise<unknown>
  }

  function getResolveSoundPathHandler(): (event: unknown) => unknown {
    const call = handleMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'notifications:resolveSoundPath'
    )
    if (!call) {
      throw new Error('notifications:resolveSoundPath handler not registered')
    }
    return call[1] as (event: unknown) => unknown
  }

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

    const handler = getDispatchHandler()
    expect(handler({}, { source: 'agent-task-complete' })).toEqual({
      delivered: false,
      reason: 'disabled'
    })
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

    const handler = getDispatchHandler()
    expect(handler({}, { source: 'agent-task-complete', isActiveWorktree: true })).toEqual({
      delivered: false,
      reason: 'suppressed-focus'
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

    const handler = getDispatchHandler()
    expect(
      handler({}, { source: 'agent-task-complete', repoLabel: 'orca', worktreeLabel: 'feat/notis' })
    ).toEqual({ delivered: true })
    expect(notificationCtorMock).toHaveBeenCalledWith({
      title: 'Task complete in feat/notis',
      body: 'orca'
    })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
  })

  it('silences the native notification when a custom sound is configured', () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: true,
          customSoundPath: '/Users/kaylee/Downloads/Note_block_pling.ogg'
        }
      })
    } as never)

    const handler = getDispatchHandler()
    expect(handler({}, { source: 'test' })).toEqual({ delivered: true })
    expect(notificationCtorMock).toHaveBeenCalledWith({
      title: 'Orca notifications are on',
      body: 'This is a test notification from Orca.',
      silent: true
    })
  })

  it('returns source-disabled when the specific source toggle is off', () => {
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
    expect(handler({}, { source: 'agent-task-complete' })).toEqual({
      delivered: false,
      reason: 'source-disabled'
    })
  })

  it('deduplicates repeated notifications for the same worktree', () => {
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
    expect(handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: true
    })
    expect(handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: false,
      reason: 'cooldown'
    })

    vi.advanceTimersByTime(5001)

    expect(handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: true
    })
    expect(notificationShowMock).toHaveBeenCalledTimes(2)
  })

  it('deduplicates agent-task-complete and terminal-bell for the same worktree', () => {
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

    expect(handler({}, { source: 'agent-task-complete', worktreeId: 'repo::wt1' })).toEqual({
      delivered: true
    })
    expect(handler({}, { source: 'terminal-bell', worktreeId: 'repo::wt1' })).toEqual({
      delivered: false,
      reason: 'cooldown'
    })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
  })

  it('loads allowed custom sound files for preload playback', async () => {
    const soundPath = join(tempDir, 'sound.ogg')
    writeFileSync(soundPath, Buffer.from([1, 2, 3]))
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false,
          customSoundPath: soundPath
        }
      })
    } as never)

    const handler = getLoadSoundHandler()
    await expect(handler({})).resolves.toMatchObject({
      ok: true,
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/ogg'
    })
  })

  it('rejects unsupported custom sound file types', async () => {
    const soundPath = join(tempDir, 'sound.txt')
    writeFileSync(soundPath, 'not audio')
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false,
          customSoundPath: soundPath
        }
      })
    } as never)

    const handler = getLoadSoundHandler()
    await expect(handler({})).resolves.toEqual({
      ok: false,
      reason: 'unsupported-type'
    })
  })

  it('resolves the sound path without reading the file', () => {
    const soundPath = join(tempDir, 'sound.ogg')
    writeFileSync(soundPath, Buffer.from([1, 2, 3]))
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false,
          customSoundPath: soundPath
        }
      })
    } as never)

    const handler = getResolveSoundPathHandler()
    expect(handler({})).toEqual({ ok: true, path: soundPath })
  })

  it('rejects unsupported types from resolveSoundPath without touching the disk', () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: true,
          suppressWhenFocused: false,
          customSoundPath: '/some/where/sound.txt'
        }
      })
    } as never)

    const handler = getResolveSoundPathHandler()
    expect(handler({})).toEqual({ ok: false, reason: 'unsupported-type' })
  })
})

describe('triggerStartupNotificationRegistration', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    notificationCtorMock.mockClear()
    notificationShowMock.mockClear()
    notificationCloseMock.mockClear()
    notificationOnMock.mockClear()
    notificationIsSupportedMock.mockReset()
    notificationIsSupportedMock.mockReturnValue(true)
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('shows welcome notification when not yet requested', () => {
    const store = {
      getUI: () => ({ notificationPermissionRequested: undefined }),
      updateUI: vi.fn()
    }

    triggerStartupNotificationRegistration(store as never)

    expect(store.updateUI).toHaveBeenCalledWith({ notificationPermissionRequested: true })
    expect(notificationCtorMock).toHaveBeenCalledWith({
      title: 'Orca is ready to notify you',
      body: 'Allow notifications so Orca can alert you when agents finish or terminals need attention.'
    })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
  })

  it('does not fire when notificationPermissionRequested flag is set', () => {
    const store = {
      getUI: () => ({ notificationPermissionRequested: true }),
      updateUI: vi.fn()
    }

    triggerStartupNotificationRegistration(store as never)

    expect(notificationCtorMock).not.toHaveBeenCalled()
  })

  it('does nothing on non-darwin platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const store = {
      getUI: () => ({ notificationPermissionRequested: undefined }),
      updateUI: vi.fn()
    }

    triggerStartupNotificationRegistration(store as never)

    expect(notificationCtorMock).not.toHaveBeenCalled()
  })
})
