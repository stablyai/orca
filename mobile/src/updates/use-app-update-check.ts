import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import Constants from 'expo-constants'
import { fetchLatestAndroidRelease, type AndroidRelease } from './android-release-feed'
import { evaluateUpdate, shouldCheckForUpdate } from './app-update-check'
import { loadUpdateCheckState, saveUpdateCheckState } from './update-check-store'
import { loadAutomaticUpdateCheckEnabled } from '../storage/preferences'

export type AppUpdatePrompt = {
  release: AndroidRelease
  currentVersion: string
}

// Why: startup is the only moment the user reliably sees a prompt, and a
// sideloaded APK has no other way to learn it is out of date.
export function useAppUpdateCheck(): {
  prompt: AppUpdatePrompt | null
  dismiss: () => void
} {
  const [prompt, setPrompt] = useState<AppUpdatePrompt | null>(null)

  useEffect(() => {
    let disposed = false

    async function run() {
      const currentVersion = Constants.expoConfig?.version
      if (!currentVersion) {
        return
      }
      const [enabled, state] = await Promise.all([
        loadAutomaticUpdateCheckEnabled(),
        loadUpdateCheckState()
      ])
      const decision = shouldCheckForUpdate({
        platform: Platform.OS,
        enabled,
        state,
        nowMs: Date.now()
      })
      if (decision.kind === 'skip' || disposed) {
        return
      }

      const release = await fetchLatestAndroidRelease()
      // Why: record the attempt either way, so an offline launch doesn't retry
      // on every subsequent launch that day.
      await saveUpdateCheckState({ ...state, lastCheckedAtMs: Date.now() })
      if (disposed) {
        return
      }

      const verdict = evaluateUpdate({
        currentVersion,
        release,
        dismissedVersion: state.dismissedVersion
      })
      if (verdict.kind === 'update-available') {
        setPrompt({ release: verdict.release, currentVersion })
      }
    }

    void run()
    return () => {
      disposed = true
    }
  }, [])

  const dismiss = useCallback(() => {
    setPrompt((current) => {
      if (current) {
        void (async () => {
          const state = await loadUpdateCheckState()
          await saveUpdateCheckState({ ...state, dismissedVersion: current.release.version })
        })()
      }
      return null
    })
  }, [])

  return { prompt, dismiss }
}
