import AsyncStorage from '@react-native-async-storage/async-storage'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { AppState, Platform } from 'react-native'
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
  const [active, setActive] = useState(AppState.currentState === 'active')
  const [focused, setFocused] = useState(true)

  useEffect(() => {
    const change = AppState.addEventListener('change', (state) => setActive(state === 'active'))
    const blur =
      Platform.OS === 'android' ? AppState.addEventListener('blur', () => setFocused(false)) : null
    const focus =
      Platform.OS === 'android' ? AppState.addEventListener('focus', () => setFocused(true)) : null
    return () => {
      change.remove()
      blur?.remove()
      focus?.remove()
    }
  }, [])

  useEffect(() => {
    if (preference && active && focused) {
      lock.hold()
    } else {
      lock.release()
    }
    return () => lock.release()
  }, [preference, active, focused])
}
