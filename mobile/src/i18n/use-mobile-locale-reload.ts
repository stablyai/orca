import { reloadAppAsync } from 'expo'
import { useLocales } from 'expo-localization'
import { useEffect, useRef, useState } from 'react'
import {
  mobileI18n,
  selectPreferredMobileUiLocale,
  shouldReloadForMobileLocaleChange,
  type MobileUiLocale
} from './mobile-i18n'

const LOCALE_RELOAD_RETRY_MS = 1_000
const LOCALE_RELOAD_MAX_ATTEMPTS = 3

type LocaleReloadRequest = { target: MobileUiLocale }

export function useMobileLocaleReload(): void {
  const locales = useLocales()
  const reloadRequestRef = useRef<LocaleReloadRequest | null>(null)
  const reloadAttemptsRef = useRef<Partial<Record<MobileUiLocale, number>>>({})
  const reloadTargetRef = useRef<MobileUiLocale | null>(null)
  const mountedRef = useRef(true)
  const [retryPending, setRetryPending] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      reloadRequestRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!retryPending) {
      return
    }
    const retryTimer = setTimeout(() => {
      setRetryPending(false)
      setRetryVersion((current) => current + 1)
    }, LOCALE_RELOAD_RETRY_MS)
    return () => clearTimeout(retryTimer)
  }, [retryPending])

  useEffect(() => {
    const languageTags = locales.map((locale) => locale.languageTag)
    const reloadTarget = selectPreferredMobileUiLocale(languageTags)
    if (!shouldReloadForMobileLocaleChange(mobileI18n.language as MobileUiLocale, languageTags)) {
      reloadTargetRef.current = null
      return
    }
    reloadTargetRef.current = reloadTarget
    const reloadAttempts = reloadAttemptsRef.current[reloadTarget] ?? 0
    if (reloadRequestRef.current || reloadAttempts >= LOCALE_RELOAD_MAX_ATTEMPTS) {
      return
    }
    const request: LocaleReloadRequest = { target: reloadTarget }
    reloadRequestRef.current = request
    reloadAttemptsRef.current[request.target] = reloadAttempts + 1
    void reloadAppAsync('Mobile locale changed').catch(() => {
      if (reloadRequestRef.current !== request) {
        return
      }
      reloadRequestRef.current = null
      const currentTarget = reloadTargetRef.current
      if (
        !mountedRef.current ||
        currentTarget === null ||
        (reloadAttemptsRef.current[currentTarget] ?? 0) >= LOCALE_RELOAD_MAX_ATTEMPTS
      ) {
        return
      }
      setRetryPending(true)
    })
  }, [locales, retryVersion])
}
