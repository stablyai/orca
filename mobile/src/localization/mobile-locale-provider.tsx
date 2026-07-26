import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  parseMobileLocale,
  translateMobileCopy,
  type MobileTranslator,
  type MobileLocale
} from './mobile-locale'

const MOBILE_LOCALE_STORAGE_KEY = 'orca:mobile-locale'

type MobileLocaleContextValue = {
  locale: MobileLocale
  storageReadFailed: boolean
  t: MobileTranslator
  setLocale: (locale: MobileLocale) => Promise<void>
}

const MobileLocaleContext = createContext<MobileLocaleContextValue | null>(null)

export function MobileLocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<MobileLocale>('en')
  const localeRevisionRef = useRef(0)
  const [storageReadFailed, setStorageReadFailed] = useState(false)

  useEffect(() => {
    let active = true
    const initialRevision = localeRevisionRef.current
    void AsyncStorage.getItem(MOBILE_LOCALE_STORAGE_KEY)
      .then((storedLocale) => {
        const parsed = parseMobileLocale(storedLocale)
        if (active && parsed && localeRevisionRef.current === initialRevision) {
          setLocaleState(parsed)
        }
      })
      .catch(() => {
        if (active && localeRevisionRef.current === initialRevision) {
          setStorageReadFailed(true)
        }
      })
    return () => {
      active = false
    }
  }, [])

  const setLocale = useCallback(async (nextLocale: MobileLocale) => {
    localeRevisionRef.current += 1
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, nextLocale)
    setLocaleState(nextLocale)
    setStorageReadFailed(false)
  }, [])

  const value = useMemo<MobileLocaleContextValue>(
    () => ({
      locale,
      storageReadFailed,
      setLocale,
      t: (key, values) => translateMobileCopy(locale, key, values)
    }),
    [locale, setLocale, storageReadFailed]
  )

  return <MobileLocaleContext.Provider value={value}>{children}</MobileLocaleContext.Provider>
}

export function useMobileLocale(): MobileLocaleContextValue {
  const context = useContext(MobileLocaleContext)
  if (!context) {
    throw new Error('useMobileLocale must be used within MobileLocaleProvider')
  }
  return context
}
