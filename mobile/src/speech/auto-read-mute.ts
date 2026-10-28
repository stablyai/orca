import { useSyncExternalStore } from 'react'
import { stopSpeaking } from './reply-speaker'
import { logSpeechEvent } from './speech-diagnostics'
import { voiceNativeModule } from './voice-native-module'

// Why: memory only and apart from the auto-read setting, so a restart always comes back unmuted.
let muted = false
const listeners = new Set<() => void>()

export function isAutoReadMuted(): boolean {
  return muted
}

export function setAutoReadMuted(next: boolean): void {
  if (next === muted) {
    return
  }
  muted = next
  logSpeechEvent(next ? 'auto-read muted' : 'auto-read unmuted')
  if (next) {
    stopSpeaking('auto-read muted')
  }
  voiceNativeModule()?.setMuted(next)
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAutoReadMuted(): boolean {
  return useSyncExternalStore(subscribe, () => muted)
}
