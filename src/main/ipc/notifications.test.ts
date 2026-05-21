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
  notificationOnceMock,
  notificationCtorMock,
  notificationIsSupportedMock,
  getAllWindowsMock,
  shellOpenExternalMock
} = vi.hoisted(() => {
  const removeHandlerMock = vi.fn()
  const handleMock = vi.fn()
  const notificationShowMock = vi.fn()
  const notificationCloseMock = vi.fn()
  const notificationOnMock = vi.fn()
  const notificationOnceMock = vi.fn()
  const notificationCtorMock = vi.fn(function () {
    return {
      show: notificationShowMock,
      close: notificationCloseMock,
      on: notificationOnMock,
      once: notificationOnceMock
    }
  })
  const notificationIsSupportedMock = vi.fn(() => true)
  const getAllWindowsMock = vi.fn(() => [])
  const shellOpenExternalMock = vi.fn()
  return {
    removeHandlerMock,
    handleMock,
    notificationShowMock,
    notificationCloseMock,
    notificationOnMock,
    notificationOnceMock,
    notificationCtorMock,
    notificationIsSupportedMock,
    getAllWindowsMock,
    shellOpenExternalMock
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
    openExternal: shellOpenExternalMock
  }
}))

import {
  registerNotificationHandlers,
  triggerStartupNotificationRegistration
} from './notifications'

describe('registerNotificationHandlers', () => {
  let tempDir: string

  function expectedNativeNotificationOptions<T extends Record<string, unknown>>(
    options: T
  ): T & { sound?: string } {
    return process.platform === 'darwin' ? { ...options, sound: 'default' } : options
  }

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
    notificationOnceMock.mockClear()
    notificationIsSupportedMock.mockReset()
    notificationIsSupportedMock.mockReturnValue(true)
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([])
    shellOpenExternalMock.mockClear()
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

  function getOpenSystemSettingsHandler(): (event: unknown) => unknown {
    const call = handleMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'notifications:openSystemSettings'
    )
    if (!call) {
      throw new Error('notifications:openSystemSettings handler not registered')
    }
    return call[1] as (event: unknown) => unknown
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

  function getNotificationEventHandler(eventName: string): () => void {
    const call = notificationOnMock.mock.calls.find((c: unknown[]) => c[0] === eventName)
    if (!call) {
      throw new Error(`Notification ${eventName} handler not registered`)
    }
    return call[1] as () => void
  }

  function getNotificationOnceEventHandler(eventName: string): () => void {
    const call = notificationOnceMock.mock.calls.find((c: unknown[]) => c[0] === eventName)
    if (!call) {
      throw new Error(`Notification ${eventName} once handler not registered`)
    }
    return call[1] as () => void
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

  it('opens the current macOS app notification settings entry', () => {
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

  it('opens Windows notification settings', () => {
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
    expect(notificationCtorMock).toHaveBeenCalledWith(
      expectedNativeNotificationOptions({
        title: 'Task complete in feat/notis',
        body: 'orca'
      })
    )
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
  })

  it('uses the macOS default notification sound when no custom sound is configured', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false,
            customSoundPath: null
          }
        })
      } as never)

      const handler = getDispatchHandler()
      expect(handler({}, { source: 'test' })).toEqual({ delivered: true })
      expect(notificationCtorMock).toHaveBeenCalledWith({
        title: 'Orca notifications are on',
        body: 'This is a test notification from Orca.',
        sound: 'default'
      })
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('does not request a native macOS sound when a custom sound is configured', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      registerNotificationHandlers({
        getSettings: () => ({
          notifications: {
            enabled: true,
            agentTaskComplete: true,
            terminalBell: true,
            suppressWhenFocused: false,
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
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('focuses the originating terminal pane when a notification with paneKey is clicked', () => {
    const webContentsSend = vi.fn()
    const restore = vi.fn()
    const focus = vi.fn()
    getAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        isFocused: () => false,
        isMinimized: () => true,
        restore,
        focus,
        webContents: { send: webContentsSend }
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

    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const handler = getDispatchHandler()
    expect(
      handler({}, { source: 'agent-task-complete', worktreeId: 'repo::wt1', paneKey })
    ).toEqual({ delivered: true })

    getNotificationEventHandler('click')()

    expect(restore).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(webContentsSend).toHaveBeenCalledWith('ui:activateWorktree', {
      repoId: 'repo',
      worktreeId: 'repo::wt1'
    })
    expect(webContentsSend).toHaveBeenCalledWith('ui:focusTerminal', {
      tabId: 'tab-1',
      worktreeId: 'repo::wt1',
      leafId: '11111111-1111-4111-8111-111111111111',
      ackPaneKeyOnSuccess: paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  it('formats agent-task-complete with the agent response when a status snapshot is present', () => {
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
      handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'feat/notis',
          repoLabel: 'orca',
          terminalTitle: '* Claude done',
          agentType: 'codex',
          agentState: 'done',
          agentPrompt: 'Fix rich notification text',
          agentLastAssistantMessage: 'Updated the notification body.'
        }
      )
    ).toEqual({ delivered: true })

    expect(notificationCtorMock).toHaveBeenCalledWith(
      expectedNativeNotificationOptions({
        title: 'feat/notis - Codex finished',
        body: 'Updated the notification body.'
      })
    )
  })

  it('includes the repo name when multiple repos are active', () => {
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
      handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'feat/notis',
          repoLabel: 'orca',
          hasMultipleActiveRepos: true,
          agentType: 'codex',
          agentState: 'done',
          agentLastAssistantMessage: 'Updated the notification body.'
        }
      )
    ).toEqual({ delivered: true })

    expect(notificationCtorMock).toHaveBeenCalledWith(
      expectedNativeNotificationOptions({
        title: 'orca / feat/notis - Codex finished',
        body: 'Updated the notification body.'
      })
    )
  })

  it('keeps a readable body when no assistant response was captured', () => {
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
      handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'main',
          repoLabel: 'jinjing-work',
          hasMultipleActiveRepos: true,
          agentType: 'claude',
          agentState: 'done',
          agentPrompt: 'Do not show this request text'
        }
      )
    ).toEqual({ delivered: true })

    expect(notificationCtorMock).toHaveBeenCalledWith(
      expectedNativeNotificationOptions({
        title: 'jinjing-work / main - Claude finished',
        body: 'Claude finished.'
      })
    )
  })

  it('formats blocked and interrupted agent snapshots distinctly', () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: false,
          suppressWhenFocused: false
        }
      })
    } as never)

    const handler = getDispatchHandler()
    expect(
      handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'feat/notis',
          agentType: 'claude',
          agentState: 'blocked',
          agentLastAssistantMessage: 'Please approve the command.'
        }
      )
    ).toEqual({ delivered: true })
    vi.advanceTimersByTime(5001)
    expect(
      handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'feat/notis',
          agentType: 'claude',
          agentState: 'done',
          agentInterrupted: true,
          agentLastAssistantMessage: 'Stopped by user.'
        }
      )
    ).toEqual({ delivered: true })

    expect(notificationCtorMock).toHaveBeenNthCalledWith(
      1,
      expectedNativeNotificationOptions({
        title: 'feat/notis - Claude needs input',
        body: 'Please approve the command.'
      })
    )
    expect(notificationCtorMock).toHaveBeenNthCalledWith(
      2,
      expectedNativeNotificationOptions({
        title: 'feat/notis - Claude stopped',
        body: 'Stopped by user.'
      })
    )
  })

  it('normalizes custom agent labels and re-bounds multiline assistant previews', () => {
    registerNotificationHandlers({
      getSettings: () => ({
        notifications: {
          enabled: true,
          agentTaskComplete: true,
          terminalBell: false,
          suppressWhenFocused: false
        }
      })
    } as never)

    const longAssistantMessage = `Line one\n\n${'x'.repeat(400)}`
    const handler = getDispatchHandler()
    expect(
      handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'feat/notis',
          agentType: 'builder\nagent',
          agentState: 'done',
          agentLastAssistantMessage: longAssistantMessage
        }
      )
    ).toEqual({ delivered: true })

    const options = (
      notificationCtorMock.mock.calls as unknown as [{ title: string; body: string }][]
    )[0]?.[0]
    if (!options) {
      throw new Error('Expected notification options')
    }
    expect(options).toMatchObject({
      title: 'feat/notis - builder agent finished'
    })
    expect(options.body).toMatch(/^Line one x+/)
    expect(options.body).not.toContain('\n')
    expect(options.body.length).toBeLessThanOrEqual(180)
  })

  it('uses tool context before falling back when no prompt or assistant preview exists', () => {
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
      handler(
        {},
        {
          source: 'agent-task-complete',
          worktreeId: 'repo::wt1',
          worktreeLabel: 'feat/notis',
          agentType: 'unknown',
          agentState: 'working',
          agentToolName: 'Bash',
          agentToolInput: 'pnpm test'
        }
      )
    ).toEqual({ delivered: true })

    expect(notificationCtorMock).toHaveBeenCalledWith(
      expectedNativeNotificationOptions({
        title: 'feat/notis - Agent finished',
        body: 'Using Bash: pnpm test'
      })
    )
  })

  it('uses rich formatter output for mobile notifications before desktop guards', () => {
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
      handler(
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
      source: 'agent-task-complete',
      title: 'feat/notis - Hermes finished',
      body: 'The diff updates notification formatting.',
      worktreeId: 'repo::wt1'
    })
    expect(notificationCtorMock).not.toHaveBeenCalled()
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

  it('does not cooldown explicit test notifications', () => {
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

    expect(handler({}, { source: 'test' })).toEqual({ delivered: true })
    expect(handler({}, { source: 'test' })).toEqual({ delivered: true })
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
    getNotificationOnceEventHandler('show')()

    await expect(result).resolves.toEqual({ delivered: true })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
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
    await vi.advanceTimersByTimeAsync(2501)

    await expect(result).resolves.toEqual({ delivered: false, reason: 'not-displayed' })
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
