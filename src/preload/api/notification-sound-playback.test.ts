import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { notificationsApi } from './notifications-bridge'

const SOUND_PATH = join(tmpdir(), 'notification.mp3')

const { construct, invoke, play } = vi.hoisted(() => ({
  construct: vi.fn((audio: { currentTime: number; volume: number; pause: () => void }) => audio),
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
          construct(this)
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

  afterEach(() => vi.unstubAllGlobals())

  it('replays the cached sound for each notification instead of deduping mid-playback', async () => {
    const notificationsApi = await loadNotificationsApi()

    await expect(notificationsApi.playSound()).resolves.toEqual({ played: true })
    const audio = construct.mock.calls[0]?.[0]
    if (!audio) {
      throw new Error('Audio was not constructed')
    }
    audio.currentTime = 0.75
    await expect(notificationsApi.playSound()).resolves.toEqual({ played: true })

    expect(audio.currentTime).toBe(0)
    expect(construct).toHaveBeenCalledOnce()
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('retries after a rejected play without leaving future notifications silent', async () => {
    const notificationsApi = await loadNotificationsApi()
    play.mockRejectedValueOnce(new Error('audio device unavailable'))
    await expect(notificationsApi.playSound()).resolves.toEqual({
      played: false,
      reason: 'playback-failed'
    })
    await expect(notificationsApi.playSound()).resolves.toEqual({ played: true })
    expect(construct).toHaveBeenCalledOnce()
  })

  it('clamps volume and stays silent when no sound is configured', async () => {
    const notificationsApi = await loadNotificationsApi()
    await notificationsApi.playSound({ volume: 150 })
    const audio = construct.mock.calls[0]?.[0]
    if (!audio) {
      throw new Error('Audio was not constructed')
    }
    expect(audio.volume).toBe(1)
    await notificationsApi.playSound({ volume: -10 })
    expect(audio.volume).toBe(0)
    invoke.mockResolvedValueOnce({ ok: false, reason: 'missing-path' })
    await expect(notificationsApi.playSound()).resolves.toEqual({
      played: false,
      reason: 'missing-path'
    })
    expect(audio.pause).toHaveBeenCalledOnce()
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
