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

export function useIsRecording() {
  const subscribe = (cb: () => void) => {
    const sub = addExpoTwoWayAudioEventListener('onRecordingChange', cb)
    return () => sub.remove()
  }
  const getSnapshot = () => isRecording()
  const getServerSnapshot = () => false

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
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
