import AsyncStorage from '@react-native-async-storage/async-storage'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { useEffect, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { createMicrophoneScreenLock } from '../platform/audio-capture/microphone-screen-lock'

const key = 'orca:keepScreenAwake'
const lock = createMicrophoneScreenLock(
  { activate: activateKeepAwakeAsync, deactivate: deactivateKeepAwake },
  'orca-screen-awake'
)
let enabled = false
let chosen = false
const listeners = new Set<() => void>()

function setEnabled(value: boolean) {
  enabled = value
  listeners.forEach((listener) => listener())
}

void AsyncStorage.getItem(key)
  .then((value) => {
    if (!chosen) {
      setEnabled(value === 'true')
    }
  })
  .catch(() => {})

export function setScreenAwakePreference(value: boolean) {
  chosen = true
  setEnabled(value)
  return AsyncStorage.setItem(key, String(value))
}

export function useScreenAwakePreference() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => enabled
  )
}

export function useScreenAwake() {
  const preference = useScreenAwakePreference()
  useEffect(() => {
    let active = AppState.currentState === 'active'
    let focused = true
    const update = () => {
      if (preference && active && focused) {
        lock.hold()
      } else {
        lock.release()
      }
    }
    const change = AppState.addEventListener('change', (state) => {
      active = state === 'active'
      if (active) {
        focused = true
      }
      update()
    })
    const blur = AppState.addEventListener('blur', () => {
      focused = false
      update()
    })
    const focus = AppState.addEventListener('focus', () => {
      focused = true
      update()
    })
    update()
    return () => {
      change.remove()
      blur.remove()
      focus.remove()
      lock.release()
    }
  }, [preference])
}
