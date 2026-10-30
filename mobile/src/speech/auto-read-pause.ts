import { useSyncExternalStore } from 'react'
import { setAutoPlay } from './reply-speaker'
import { logSpeechEvent } from './speech-diagnostics'
import { voiceNativeModule } from './voice-native-module'

// Why: memory only and apart from the auto-read setting, so a restart always resumes auto-read.
// While paused, new messages wait in the reader's queue instead of being dropped.
let paused = false
const listeners = new Set<() => void>()

export function isAutoReadPaused(): boolean {
  return paused
}

export function setAutoReadPaused(next: boolean): void {
  if (next === paused) {
    return
  }
  paused = next
  logSpeechEvent(next ? 'auto-read paused' : 'auto-read resumed')
  setAutoPlay(!next)
  voiceNativeModule()?.setAutoReadPaused(next)
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAutoReadPaused(): boolean {
  return useSyncExternalStore(subscribe, () => paused)
}
