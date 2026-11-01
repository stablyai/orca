import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLoadSoundHandler, resetNotificationDispatchMocks } from './notifications-test-harness'

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
})
