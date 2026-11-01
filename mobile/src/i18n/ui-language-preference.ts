import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'
import { SUPPORTED_UI_LOCALES, type SupportedUiLocale } from '../../../src/shared/ui-locale'
import { UI_LANGUAGE_SYSTEM } from '../../../src/shared/ui-language'
import { activateMobileUiLocale } from './mobile-i18n'
import { readDeviceUiLocaleTags, resolveUiLocaleFromTags } from './system-ui-locale'

// Same values as desktop's built-in uiLanguage; System follows the phone's (or per-app) language.
export type MobileUiLanguagePreference = typeof UI_LANGUAGE_SYSTEM | SupportedUiLocale

const UI_LANGUAGE_KEY = 'orca:uiLanguage'

let preference: MobileUiLanguagePreference = UI_LANGUAGE_SYSTEM
// A choice made while the saved one is still loading wins over the stale read.
let chosenThisLaunch = false
let started: Promise<void> | null = null
const preferenceListeners = new Set<() => void>()

export function isMobileUiLanguagePreference(value: unknown): value is MobileUiLanguagePreference {
  return value === UI_LANGUAGE_SYSTEM || SUPPORTED_UI_LOCALES.some((locale) => locale === value)
}

export function resolveMobileUiLocale(
  next: MobileUiLanguagePreference,
  deviceTags: readonly string[] = readDeviceUiLocaleTags()
): SupportedUiLocale {
  return next === UI_LANGUAGE_SYSTEM ? resolveUiLocaleFromTags(deviceTags) : next
}

function adoptPreference(next: MobileUiLanguagePreference): Promise<void> {
  preference = next
  for (const listener of preferenceListeners) {
    listener()
  }
  return activateMobileUiLocale(resolveMobileUiLocale(next))
}

// Resolves once the saved choice is active (English on any failure), so the splash covers the switch.
export function startMobileUiLanguage(): Promise<void> {
  if (started !== null) {
    return started
  }
  const deviceLocale = activateMobileUiLocale(resolveMobileUiLocale(UI_LANGUAGE_SYSTEM))
  const stored = AsyncStorage.getItem(UI_LANGUAGE_KEY)
    .then((value) =>
      !chosenThisLaunch && isMobileUiLanguagePreference(value) && value !== preference
        ? adoptPreference(value)
        : undefined
    )
    .catch(() => undefined)
  started = Promise.all([deviceLocale, stored]).then(() => undefined)
  return started
}

export function setMobileUiLanguagePreference(next: MobileUiLanguagePreference): Promise<void> {
  chosenThisLaunch = true
  const activated = adoptPreference(next)
  return Promise.all([activated, AsyncStorage.setItem(UI_LANGUAGE_KEY, next)]).then(() => undefined)
}

// Device or per-app language changed while running; only System follows it.
export function followDeviceUiLocale(deviceTags: readonly string[]): Promise<void> {
  return preference === UI_LANGUAGE_SYSTEM
    ? activateMobileUiLocale(resolveUiLocaleFromTags(deviceTags))
    : Promise.resolve()
}

function subscribePreference(listener: () => void): () => void {
  preferenceListeners.add(listener)
  return () => {
    preferenceListeners.delete(listener)
  }
}

export function useMobileUiLanguagePreference(): MobileUiLanguagePreference {
  return useSyncExternalStore(subscribePreference, () => preference)
}
