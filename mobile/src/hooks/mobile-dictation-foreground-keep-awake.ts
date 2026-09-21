import { useEffect } from 'react'
import { AppState, Platform } from 'react-native'
import { drainMobileDictationKeepAwakeCleanup } from './mobile-dictation-keep-awake'
import type { RefObject } from 'react'
import type { DictationKeepAwakeDevice } from '../platform/dictation-capture-contract'
import type { MobileDictationKeepAwakeOwner } from './mobile-dictation-keep-awake'

// A transient Activity gap can fail a foreground refresh; retry briefly while
// the same dictation is live instead of waiting for the next foreground.
const REACQUIRE_RETRY_DELAYS_MS = [1_000, 5_000]

let globalStaleTagDrainInstalled = false
// The drain outlives every owner, so it reads the newest device rather than capturing one: on the
// page that device is built from a bridge client the screen can replace, and a captured one would
// deactivate through a port nothing is listening on.
let latestKeepAwakeDevice: DictationKeepAwakeDevice | null = null

// Failed final deactivations must be retried even after every session screen
// unmounts, or a stale native tag keeps the screen awake until app restart.
// Installed once for the app's lifetime; the drain spares still-wanted tags
// and fast-paths to a no-op when nothing is pending.
function installGlobalStaleTagForegroundDrain(device: DictationKeepAwakeDevice): void {
  latestKeepAwakeDevice = device
  if (globalStaleTagDrainInstalled) {
    return
  }
  globalStaleTagDrainInstalled = true
  AppState.addEventListener('change', (state) => {
    const current = latestKeepAwakeDevice
    if (state === 'active' && current !== null) {
      void drainMobileDictationKeepAwakeCleanup(current).catch(() => undefined)
    }
  })
}

export function useMobileDictationForegroundKeepAwake(
  keepAwakeOwner: MobileDictationKeepAwakeOwner,
  activeIdRef: RefObject<string | null>,
  keepAwakeDevice: DictationKeepAwakeDevice
): void {
  useEffect(() => {
    installGlobalStaleTagForegroundDrain(keepAwakeDevice)
    // Android keeps FLAG_KEEP_SCREEN_ON on the Activity window, so Activity
    // recreation silently drops it mid-dictation; refresh on return to
    // active. iOS re-applies natively on foreground.
    if (Platform.OS !== 'android') {
      return
    }
    // A retry from an earlier foreground event can outlive a newer reacquire and
    // deactivate the recovered tag; a run token invalidated on each AppState
    // change and on unmount drops superseded retry chains.
    let reacquireRun = 0
    const reacquireWithRetry = (dictationId: string, attempt: number, run: number): void => {
      void keepAwakeOwner.reacquire(dictationId).catch(() => {
        const delay = REACQUIRE_RETRY_DELAYS_MS[attempt]
        if (delay === undefined) {
          return
        }
        setTimeout(() => {
          if (reacquireRun === run && activeIdRef.current === dictationId) {
            reacquireWithRetry(dictationId, attempt + 1, run)
          }
        }, delay)
      })
    }
    const sub = AppState.addEventListener('change', (state) => {
      const run = ++reacquireRun
      const dictationId = activeIdRef.current
      if (state === 'active' && dictationId) {
        reacquireWithRetry(dictationId, 0, run)
      }
    })
    return () => {
      reacquireRun += 1
      sub.remove()
    }
  }, [keepAwakeOwner, activeIdRef, keepAwakeDevice])
}
