import { useFocusEffect } from 'expo-router'
import { useCallback } from 'react'
import { AppState } from 'react-native'
import { setForegroundTimer } from '../mobile-web-shell/foreground-timer'
import {
  enterHomeSparePage,
  homeSpareRefillWaitMs,
  leaveHomeSparePage,
  prepareHomeSparePage
} from '../mobile-web-shell/home-spare-page'
import { processGenerationStore } from '../mobile-web-shell/generations/process-generation-store'

// Past Home's first paint and its first reads, so the boot never competes with them.
const HOME_SPARE_IDLE_MS = 1000

const HOST_ID_SEPARATOR = '\n'

// While Home is shown, keep one page booted for the most recently connected host with a cached build.
// Native drops it when the app leaves the foreground, so every return to it arms again.
export function useHomeSparePage(hostIds: readonly string[]): void {
  const hosts = hostIds.join(HOST_ID_SEPARATOR)
  useFocusEffect(
    useCallback(() => {
      if (hosts === '') {
        return undefined
      }
      enterHomeSparePage()
      let cancelTimer = (): void => undefined
      const arm = (): void => {
        cancelTimer()
        cancelTimer = setForegroundTimer(
          () => void prepareHomeSparePage(processGenerationStore(), hosts.split(HOST_ID_SEPARATOR)),
          Math.max(HOME_SPARE_IDLE_MS, Math.ceil(homeSpareRefillWaitMs()))
        )
      }
      arm()
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          arm()
        }
      })
      return () => {
        subscription.remove()
        cancelTimer()
        leaveHomeSparePage()
      }
    }, [hosts])
  )
}
