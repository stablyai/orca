import { reloadAppAsync } from 'expo'
import { useLocales } from 'expo-localization'
import { useEffect, useRef } from 'react'
import { mobileI18n, shouldReloadForMobileLocaleChange, type MobileUiLocale } from './mobile-i18n'

export function useMobileLocaleReload(): void {
  const locales = useLocales()
  const reloadRequestedRef = useRef(false)

  useEffect(() => {
    if (
      reloadRequestedRef.current ||
      !shouldReloadForMobileLocaleChange(
        mobileI18n.language as MobileUiLocale,
        locales.map((locale) => locale.languageTag)
      )
    ) {
      return
    }
    reloadRequestedRef.current = true
    void reloadAppAsync('Mobile locale changed').catch(() => {
      reloadRequestedRef.current = false
    })
  }, [locales])
}
