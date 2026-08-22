// Why (#15933): a stalled Audio element — an OS audio route change, a device sleep
// mid-play, a decode stall — fires neither `ended` nor `error`. The dedupe flag used to
// clear only on those events, so one stall latched it true forever and every later
// completion notification silently returned 'deduped' (the renderer treats that reason
// as expected burst coalescing and does not warn). A time bound releases the window so
// one stall costs at most one miss, not all subsequent sounds.
export const MAX_NOTIFICATION_SOUND_PLAYBACK_MS = 10_000

type AudioElementLike = Pick<HTMLAudioElement, 'addEventListener' | 'removeEventListener'>

export type NotificationSoundPlayback = {
  isPlaying: () => boolean
  /** Marks playback in flight against the given element; returns the release function. */
  begin: (audio: AudioElementLike) => () => void
  /** Releases an in-flight playback, if any (dispose/reload paths). */
  forceRelease: () => void
}

export function createNotificationSoundPlayback(): NotificationSoundPlayback {
  let playing = false
  let finishCurrent: (() => void) | null = null

  function begin(audio: AudioElementLike): () => void {
    finishCurrent?.()
    playing = true
    let done = false
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (done) {
        return
      }
      done = true
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
      audio.removeEventListener('ended', finish)
      audio.removeEventListener('error', finish)
      playing = false
    }
    fallbackTimer = setTimeout(finish, MAX_NOTIFICATION_SOUND_PLAYBACK_MS)
    audio.addEventListener('ended', finish)
    audio.addEventListener('error', finish)
    finishCurrent = finish
    return finish
  }

  return {
    isPlaying: () => playing,
    begin,
    forceRelease: () => {
      finishCurrent?.()
    }
  }
}
