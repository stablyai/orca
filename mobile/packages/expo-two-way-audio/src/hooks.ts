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

// Stable listener identities avoid useSyncExternalStore resubscriptions on every render.
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
