import {
  addExpoTwoWayAudioEventListener,
  getMicrophonePermissionsAsync,
  initialize,
  requestMicrophonePermissionsAsync,
  tearDown,
  toggleRecording
} from '@orca/expo-two-way-audio'
import { AppState } from 'react-native'
import { createMobileDictationKeepAwakeOwner } from '../hooks/mobile-dictation-keep-awake'
import type { MobileWebSpeechRuntime } from './mobile-web-speech-runtime'

const FOREGROUND_RESUME_TIMEOUT_MS = 2_000

export function createMobileWebSpeechNativeRuntime(): MobileWebSpeechRuntime {
  const keepAwake = createMobileDictationKeepAwakeOwner()
  return {
    requestMicrophonePermission: async () => {
      const current = await getMicrophonePermissionsAsync()
      return current.granted ? current : requestMicrophonePermissionsAsync()
    },
    waitForForeground,
    initialize,
    toggleRecording,
    tearDown,
    addMicrophoneListener(listener) {
      const subscription = addExpoTwoWayAudioEventListener('onMicrophoneData', listener)
      return () => subscription.remove()
    },
    addInterruptionListener(listener) {
      const subscription = addExpoTwoWayAudioEventListener('onAudioInterruption', (event) =>
        listener(event.data)
      )
      return () => subscription.remove()
    },
    acquireKeepAwake: (dictationId) => keepAwake.acquire(dictationId),
    releaseKeepAwake: (dictationId) => keepAwake.release(dictationId)
  }
}

async function waitForForeground(): Promise<boolean> {
  if (AppState.currentState === 'active') {
    return true
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let subscription: { remove(): void } | null = null
    const finish = (foreground: boolean): void => {
      if (timer) {
        clearTimeout(timer)
      }
      subscription?.remove()
      resolve(foreground)
    }
    subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        finish(true)
      }
    })
    timer = setTimeout(() => finish(false), FOREGROUND_RESUME_TIMEOUT_MS)
    if (AppState.currentState === 'active') {
      finish(true)
    }
  })
}
