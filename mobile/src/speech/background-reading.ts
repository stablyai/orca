import { useCallback, useEffect } from 'react'
import { AppState } from 'react-native'
import {
  BACKGROUND_READING_KEY,
  DEFAULT_BACKGROUND_READING,
  type StoredFlag
} from '../storage/speech-preferences'
import { isAutoReadPaused, setAutoReadPaused } from './auto-read-pause'
import { setBackgroundReadingActive } from './background-reading-state'
import { logSpeechEvent } from './speech-diagnostics'
import { createStoredChoice } from './stored-choice'
import { voiceNativeModule } from './voice-native-module'

// Why: matches the auto-reader's background poll interval.
const TICK_MS = 15_000

const background = voiceNativeModule

const useBackgroundReadingChoice = createStoredChoice<StoredFlag>(
  BACKGROUND_READING_KEY,
  ['true', 'false'],
  DEFAULT_BACKGROUND_READING
)

// Why: isRunning() stays false until the service has started, which a stop must not wait for.
let startRequested = false

export function useBackgroundReadingPreference(): {
  backgroundReading: boolean
  setBackgroundReading: (next: boolean) => void
} {
  const { value, setValue } = useBackgroundReadingChoice()
  const setBackgroundReading = useCallback(
    (next: boolean) => setValue(next ? 'true' : 'false'),
    [setValue]
  )
  return { backgroundReading: value === 'true', setBackgroundReading }
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
        if (startRequested || native.isRunning()) {
          native.stop()
        }
        startRequested = false
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
      startRequested = started
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
