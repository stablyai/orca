import { createPermissionHook } from 'expo-modules-core'
import { useEffect, useSyncExternalStore } from 'react'
import {
  getMicrophonePermissionsAsync,
  isRecording,
  requestMicrophonePermissionsAsync
} from './core'
import { ExpoTwoWayAudioEventMap, addExpoTwoWayAudioEventListener } from './events'

export const useMicrophonePermissions = createPermissionHook({
  getMethod: getMicrophonePermissionsAsync,
  requestMethod: requestMicrophonePermissionsAsync
})

// Why: useSyncExternalStore resubscribes when these identities change; keep
// the native recording listener stable across component re-renders.
const subscribeToRecordingChanges = (cb: () => void) => {
  const sub = addExpoTwoWayAudioEventListener('onRecordingChange', cb)
  return () => sub.remove()
}
const getRecordingSnapshot = () => isRecording()
const getServerRecordingSnapshot = () => false

export function useIsRecording() {
  return useSyncExternalStore(
    subscribeToRecordingChanges,
    getRecordingSnapshot,
    getServerRecordingSnapshot
  )
}

export function useExpoTwoWayAudioEventListener<K extends keyof ExpoTwoWayAudioEventMap>(
  eventName: K,
  listener: (ev: ExpoTwoWayAudioEventMap[K]) => void
) {
  useEffect(() => {
    const sub = addExpoTwoWayAudioEventListener(eventName, listener)
    return () => sub.remove()
  }, [eventName, listener])
}
