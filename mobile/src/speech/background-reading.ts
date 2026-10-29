import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import {
  DEFAULT_BACKGROUND_READING,
  loadBackgroundReading,
  saveBackgroundReading
} from '../storage/speech-preferences'
import { isAutoReadPaused, setAutoReadPaused } from './auto-read-pause'
import { setBackgroundReadingActive } from './background-reading-state'
import { logSpeechEvent } from './speech-diagnostics'
import { voiceNativeModule } from './voice-native-module'

// Why: matches the auto-reader's background poll interval.
const TICK_MS = 15_000

const background = voiceNativeModule

let preferred = DEFAULT_BACKGROUND_READING
let preferenceLoad: Promise<void> | null = null
let preferenceChanged = false
const preferenceListeners = new Set<() => void>()

function emitPreference(): void {
  for (const listener of preferenceListeners) {
    listener()
  }
}

export function useBackgroundReadingPreference(): {
  backgroundReading: boolean
  setBackgroundReading: (next: boolean) => void
} {
  useEffect(() => {
    preferenceLoad ??= loadBackgroundReading().then((stored) => {
      if (!preferenceChanged && stored !== preferred) {
        preferred = stored
        emitPreference()
      }
    })
  }, [])
  const backgroundReading = useSyncExternalStore(
    (listener) => {
      preferenceListeners.add(listener)
      return () => preferenceListeners.delete(listener)
    },
    () => preferred
  )
  const setBackgroundReading = useCallback((next: boolean) => {
    preferenceChanged = true
    preferred = next
    emitPreference()
    void saveBackgroundReading(next).catch(() => undefined)
  }, [])
  return { backgroundReading, setBackgroundReading }
}

// Why: JS timers pause in the background, so a native foreground service's ticks drive polling; the
// host link stays foreground meanwhile (`host-logical-client.ts`) or the relay drops after 30 s.
export function useBackgroundReadingService(wanted: boolean, onTick: () => void): void {
  useEffect(() => {
    const native = background()
    if (!wanted || native === null) {
      return
    }
    const subscription = native.addListener('onTick', onTick)
    // Why: the service brings only the auto-read pause; reading buttons use `reader-controls.ts`.
    const pauseButton = native.addListener('onAutoReadToggle', () =>
      setAutoReadPaused(!isAutoReadPaused())
    )
    return () => {
      subscription.remove()
      pauseButton.remove()
    }
  }, [wanted, onTick])

  // Why: also synced on return to the screen, the only time Android allows a start; never stopped
  // on unmount, since a remount off screen could not start it again.
  useEffect(() => {
    const native = background()
    if (native === null) {
      return
    }
    const sync = () => {
      // Why: the notification shows this process's pause, never one a previous run left behind.
      native.setAutoReadPaused(isAutoReadPaused())
      if (!wanted) {
        if (native.isRunning()) {
          native.stop()
        }
        setBackgroundReadingActive(false)
        return
      }
      if (native.isRunning()) {
        setBackgroundReadingActive(true)
        return
      }
      if (AppState.currentState !== 'active') {
        setBackgroundReadingActive(false)
        return
      }
      const started = native.start('Orca', 'Reading agent replies aloud', TICK_MS)
      setBackgroundReadingActive(started)
      if (!started) {
        logSpeechEvent('background service refused by Android')
      }
    }
    sync()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        sync()
      }
    })
    return () => subscription.remove()
  }, [wanted])
}
