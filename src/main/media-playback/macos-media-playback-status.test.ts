import { describe, expect, it, vi } from 'vitest'
import type { MediaPlaybackCommandRunner } from './macos-media-playback-status'
import {
  createMediaPlaybackStatusReader,
  parseMediaPlaybackOutput,
  selectMediaPlaybackStatus
} from './macos-media-playback-status'

describe('macOS media playback status', () => {
  it('parses and normalizes AppleScript fields', () => {
    expect(parseMediaPlaybackOutput('spotify', 'playing\u001f AtHeart \u001fSay\nIt\n')).toEqual({
      player: 'spotify',
      state: 'playing',
      artist: 'AtHeart',
      track: 'Say It'
    })
    expect(parseMediaPlaybackOutput('apple-music', '')).toBeNull()
  })

  it('matches tmux priority and retains the prior paused player', () => {
    const spotify = {
      player: 'spotify' as const,
      state: 'paused' as const,
      artist: 'Artist S',
      track: 'Track S'
    }
    const appleMusic = {
      player: 'apple-music' as const,
      state: 'playing' as const,
      artist: 'Artist A',
      track: 'Track A'
    }

    expect(selectMediaPlaybackStatus([spotify, appleMusic], 'spotify')).toBe(appleMusic)
    expect(
      selectMediaPlaybackStatus([spotify, { ...appleMusic, state: 'paused' }], 'apple-music')
    ).toMatchObject({ player: 'apple-music' })
  })

  it('queries both running players and caches the selected status for three seconds', async () => {
    let currentTime = 1_000
    const commandRunner = vi.fn(async (file: string, args: string[]) => {
      if (file === '/usr/bin/pgrep') {
        return { stdout: `${args.at(-1)}\n` }
      }
      const script = args.at(-1) ?? ''
      return script.includes('com.spotify.client')
        ? { stdout: 'paused\u001fSpotify Artist\u001fSpotify Track\n' }
        : { stdout: 'playing\u001fMusic Artist\u001fMusic Track\n' }
    }) as MediaPlaybackCommandRunner
    const read = createMediaPlaybackStatusReader({
      platform: 'darwin',
      commandRunner,
      now: () => currentTime
    })

    await expect(read()).resolves.toMatchObject({ player: 'apple-music', state: 'playing' })
    await expect(read()).resolves.toMatchObject({ player: 'apple-music' })
    expect(commandRunner).toHaveBeenCalledTimes(4)

    currentTime += 3_000
    await read()
    expect(commandRunner).toHaveBeenCalledTimes(8)
  })

  it('does not probe local players outside macOS', async () => {
    const commandRunner = vi.fn() as unknown as MediaPlaybackCommandRunner
    const read = createMediaPlaybackStatusReader({ platform: 'linux', commandRunner })

    await expect(read()).resolves.toBeNull()
    expect(commandRunner).not.toHaveBeenCalled()
  })
})
