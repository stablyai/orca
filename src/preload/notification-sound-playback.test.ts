import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNotificationSoundPlayback,
  MAX_NOTIFICATION_SOUND_PLAYBACK_MS
} from './notification-sound-playback'

type Listener = (...args: unknown[]) => void

function fakeAudio(): {
  audio: Pick<HTMLAudioElement, 'addEventListener' | 'removeEventListener'>
  emit: (event: 'ended' | 'error') => void
  listeners: Map<string, Listener[]>
} {
  const listeners = new Map<string, Listener[]>()
  return {
    audio: {
      addEventListener: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener as Listener])
      },
      removeEventListener: (event, listener) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((candidate) => candidate !== listener)
        )
      }
    },
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) {
        listener()
      }
    },
    listeners
  }
}

describe('createNotificationSoundPlayback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('releases the dedupe window when playback ends normally', () => {
    const playback = createNotificationSoundPlayback()
    const { audio, emit } = fakeAudio()

    playback.begin(audio)
    expect(playback.isPlaying()).toBe(true)

    emit('ended')
    expect(playback.isPlaying()).toBe(false)
  })

  it('releases the dedupe window on playback error', () => {
    const playback = createNotificationSoundPlayback()
    const { audio, emit } = fakeAudio()

    playback.begin(audio)
    emit('error')
    expect(playback.isPlaying()).toBe(false)
  })

  // Regression (#15933): an OS audio route change or device sleep mid-play stalls the
  // element so neither ended nor error ever fires; the flag used to stay latched true and
  // every later completion notification silently returned 'deduped'.
  it('releases the dedupe window when the element stalls without any event', () => {
    const playback = createNotificationSoundPlayback()
    const { audio } = fakeAudio()

    playback.begin(audio)
    expect(playback.isPlaying()).toBe(true)

    vi.advanceTimersByTime(MAX_NOTIFICATION_SOUND_PLAYBACK_MS - 1)
    expect(playback.isPlaying()).toBe(true)

    vi.advanceTimersByTime(1)
    expect(playback.isPlaying()).toBe(false)
  })

  it('stops the fallback timer once ended fires, and a late timer fires nothing', () => {
    const playback = createNotificationSoundPlayback()
    const first = fakeAudio()
    playback.begin(first.audio)
    first.emit('ended')

    // The timer for the finished playback must not release the NEXT one early.
    const second = fakeAudio()
    playback.begin(second.audio)
    vi.advanceTimersByTime(MAX_NOTIFICATION_SOUND_PLAYBACK_MS + 5)
    expect(playback.isPlaying()).toBe(false)

    second.emit('ended')
    expect(playback.isPlaying()).toBe(false)
  })

  it('accepts a new playback while one is stuck, releasing the previous', () => {
    const playback = createNotificationSoundPlayback()
    const stuck = fakeAudio()
    playback.begin(stuck.audio)

    const fresh = fakeAudio()
    playback.begin(fresh.audio)
    expect(playback.isPlaying()).toBe(true)

    // The stuck playback's late ended must not release the fresh window.
    stuck.emit('ended')
    expect(playback.isPlaying()).toBe(true)

    fresh.emit('ended')
    expect(playback.isPlaying()).toBe(false)
  })

  it('forceRelease drops an in-flight window and listeners are unhooked', () => {
    const playback = createNotificationSoundPlayback()
    const { audio, listeners } = fakeAudio()

    const release = playback.begin(audio)
    playback.forceRelease()
    expect(playback.isPlaying()).toBe(false)

    // Idempotent: a later release() (audio.play() rejection path) is a no-op.
    release()
    expect(playback.isPlaying()).toBe(false)
    expect(listeners.get('ended')).toHaveLength(0)
    expect(listeners.get('error')).toHaveLength(0)
  })
})
