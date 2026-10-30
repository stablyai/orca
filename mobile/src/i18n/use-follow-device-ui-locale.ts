import { useLocales } from 'expo-localization'
import { useEffect, useRef } from 'react'
import { followDeviceUiLocale } from './ui-language-preference'

// iOS relaunches the app for language changes, but Android 13+ per-app changes arrive live.
export function useFollowDeviceUiLocale(): void {
  const locales = useLocales()
  const initial = useRef(locales)
  useEffect(() => {
    if (locales === initial.current) {
      return
    }
    void followDeviceUiLocale(locales.map((locale) => locale.languageTag))
  }, [locales])
}
