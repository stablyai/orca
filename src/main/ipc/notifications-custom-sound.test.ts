import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getDispatchHandler,
  getLoadSoundHandler,
  getResolveSoundPathHandler,
  notificationCtorMock,
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
  let tempDir: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-28T16:00:00Z'))
    tempDir = mkdtempSync(join(tmpdir(), 'orca-notification-test-'))
    resetNotificationDispatchMocks()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    'leaves native System sound options unset on %s',
    async (platform) => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      try {
        registerNotificationHandlers({
          getSettings: () => ({
            notifications: {
              enabled: true,
              agentTaskComplete: true,
              terminalBell: true,
              suppressWhenFocused: false,
              customSoundId: 'system',
              customSoundPath: null
            }
          })
        } as never)

        const handler = getDispatchHandler()
        for (const source of ['test', 'agent-task-complete', 'terminal-bell'] as const) {
          expect(await handler({}, { source, worktreeId: source })).toEqual({ delivered: true })
        }
        expect(notificationCtorMock).toHaveBeenCalledWith({
          title: 'Orca notifications are on',
          body: 'This is a test notification from Orca.'
        })
        expect(notificationCtorMock).toHaveBeenCalledTimes(3)
        for (const [options] of notificationCtorMock.mock.calls) {
          expect(options).not.toHaveProperty('sound')
          expect(options).not.toHaveProperty('silent')
        }
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
    }
  )

  it.each(['custom', 'two-tone'] as const)(
    'silences the native macOS notification when %s playback is selected',
    async (customSoundId) => {
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
              customSoundId,
              customSoundPath: customSoundId === 'custom' ? join(tempDir, 'notification.ogg') : null
            }
          })
        } as never)

        const handler = getDispatchHandler()
        expect(await handler({}, { source: 'test' })).toEqual({ delivered: true })
        expect(notificationCtorMock).toHaveBeenCalledWith({
          title: 'Orca notifications are on',
          body: 'This is a test notification from Orca.',
          silent: true
        })
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
    }
  )

  it('silences the native notification when a custom sound is configured', async () => {
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
    expect(await handler({}, { source: 'test' })).toEqual({ delivered: true })
    expect(notificationCtorMock).toHaveBeenCalledWith({
      title: 'Orca notifications are on',
      body: 'This is a test notification from Orca.',
      silent: true
    })
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
    expect(await handler({})).toEqual({
      ok: false,
      reason: 'unsupported-type'
    })
  })

  it('resolves the sound path without reading the file', async () => {
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
    expect(await handler({})).toEqual({ ok: true, path: soundPath })
  })

  it('rejects unsupported types from resolveSoundPath without touching the disk', async () => {
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
    expect(await handler({})).toEqual({ ok: false, reason: 'unsupported-type' })
  })
})
