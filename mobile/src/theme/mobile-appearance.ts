import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'
import { AppState, Appearance } from 'react-native'
import { applyMobileColorScheme } from './mobile-theme'

// Same choices as desktop's theme setting; System follows the phone.
export type MobileAppearancePreference = 'system' | 'light' | 'dark'

const APPEARANCE_KEY = 'orca:appearance'

let preference: MobileAppearancePreference = 'system'
// A choice made while the saved one is still loading wins over the stale read.
let chosenThisLaunch = false
let started: Promise<void> | null = null
const preferenceListeners = new Set<() => void>()

function isAppearancePreference(value: unknown): value is MobileAppearancePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

// Appearance carries the override too, so native alerts, pickers, the keyboard and WebViews match the app.
function applyAppearance(): void {
  // iOS flips the trait collection while snapshotting a backgrounded app; settle on return instead.
  if (AppState.currentState === 'background') {
    return
  }
  applyMobileColorScheme(Appearance.getColorScheme() === 'light' ? 'light' : 'dark')
}

function adoptPreference(next: MobileAppearancePreference): void {
  preference = next
  Appearance.setColorScheme(next === 'system' ? 'unspecified' : next)
  applyAppearance()
  for (const listener of preferenceListeners) {
    listener()
  }
}

// Resolves once the saved choice is applied, so the splash can cover the first themed frame.
export function startMobileAppearance(): Promise<void> {
  if (started !== null) {
    return started
  }
  applyAppearance()
  Appearance.addChangeListener(applyAppearance)
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      applyAppearance()
    }
  })
  started = AsyncStorage.getItem(APPEARANCE_KEY)
    .then((stored) => {
      if (!chosenThisLaunch && isAppearancePreference(stored) && stored !== preference) {
        adoptPreference(stored)
      }
    })
    .catch(() => undefined)
  return started
}

export function setMobileAppearancePreference(next: MobileAppearancePreference): Promise<void> {
  chosenThisLaunch = true
  adoptPreference(next)
  return AsyncStorage.setItem(APPEARANCE_KEY, next)
}

function subscribePreference(listener: () => void): () => void {
  preferenceListeners.add(listener)
  return () => {
    preferenceListeners.delete(listener)
  }
}

export function useMobileAppearancePreference(): MobileAppearancePreference {
  return useSyncExternalStore(subscribePreference, () => preference)
}
