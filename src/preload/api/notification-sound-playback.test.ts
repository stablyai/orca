import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { notificationsApi } from './notifications-bridge'

const SOUND_PATH = join(tmpdir(), 'notification.mp3')

const { construct, invoke, play } = vi.hoisted(() => ({
  construct: vi.fn(),
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
    construct.mockClear()
    play.mockClear()
    vi.stubGlobal(
      'Audio',
      class extends EventTarget {
        currentTime = 0
        volume = 1
        src = ''
        pause = vi.fn()
        play = play

        constructor() {
          super()
          construct()
        }
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

  it('replays the cached sound for each notification instead of deduping mid-playback', async () => {
    const notificationsApi = await loadNotificationsApi()

    await expect(notificationsApi.playSound()).resolves.toEqual({ played: true })
    await expect(notificationsApi.playSound()).resolves.toEqual({ played: true })

    expect(construct).toHaveBeenCalledOnce()
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('shares one cached Audio across concurrent first playback', async () => {
    const notificationsApi = await loadNotificationsApi()

    await expect(
      Promise.all([notificationsApi.playSound(), notificationsApi.playSound()])
    ).resolves.toEqual([{ played: true }, { played: true }])

    expect(construct).toHaveBeenCalledOnce()
    expect(play).toHaveBeenCalledTimes(2)
  })
})
