import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { notificationsApi } from './notifications-bridge'

const SOUND_PATH = join(tmpdir(), 'notification.mp3')

const { invoke, play } = vi.hoisted(() => ({
  invoke: vi.fn(),
  play: vi.fn(() => Promise.resolve())
}))

vi.mock('electron', () => ({ ipcRenderer: { invoke } }))

async function loadNotificationsApi(): Promise<typeof notificationsApi> {
  vi.resetModules()
  return (await import('./notifications-bridge')).notificationsApi
}

describe('notificationsApi.playSound', () => {
  beforeEach(() => {
    play.mockClear()
    vi.stubGlobal(
      'Audio',
      class extends EventTarget {
        currentTime = 0
        volume = 1
        src = ''
        pause = vi.fn()
        play = play
      }
    )
    invoke.mockReset()
    invoke.mockImplementation((channel: string) => {
      if (channel === 'notifications:resolveSoundPath') {
        return Promise.resolve({ ok: true, path: SOUND_PATH })
      }
      if (channel === 'notifications:loadSound') {
        return Promise.resolve({
          ok: true,
          data: new Uint8Array([1]),
          mimeType: 'audio/mpeg',
          path: SOUND_PATH
        })
      }
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('retries after a rejected play without leaving future notifications silent', async () => {
    const notificationsApi = await loadNotificationsApi()
    play.mockRejectedValueOnce(new Error('audio device unavailable'))
    await expect(notificationsApi.playSound()).resolves.toEqual({
      played: false,
      reason: 'playback-failed'
    })
    await expect(notificationsApi.playSound()).resolves.toEqual({
      played: true
    })
  })

  it('skips playback under macOS Focus but keeps the cached sound for previews', async () => {
    const notificationsApi = await loadNotificationsApi()
    await expect(notificationsApi.playSound()).resolves.toEqual({
      played: true
    })
    invoke.mockImplementation((channel: string, options?: { force?: boolean }) =>
      channel === 'notifications:resolveSoundPath'
        ? Promise.resolve(
            options?.force ? { ok: true, path: SOUND_PATH } : { ok: false, reason: 'focus-active' }
          )
        : Promise.reject(new Error(`unexpected ${channel}`))
    )
    play.mockClear()
    await expect(notificationsApi.playSound()).resolves.toEqual({
      played: false,
      reason: 'focus-active'
    })
    expect(play).not.toHaveBeenCalled()
    await expect(notificationsApi.playSound({ force: true })).resolves.toEqual({
      played: true
    })
    expect(play).toHaveBeenCalledTimes(1)
  })
})
