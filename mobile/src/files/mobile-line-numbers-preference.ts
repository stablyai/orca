import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

export const MOBILE_FILE_PREVIEW_LINE_NUMBERS_STORAGE_KEY =
  'orca:mobile:file-preview:line-numbers'

export function parseMobileLineNumbersPreference(raw: string | null): boolean {
  if (raw === null) {
    return true
  }
  return raw === 'true'
}

export async function readMobileLineNumbersPreference(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(MOBILE_FILE_PREVIEW_LINE_NUMBERS_STORAGE_KEY)
    return parseMobileLineNumbersPreference(raw)
  } catch {
    return true
  }
}

export async function writeMobileLineNumbersPreference(value: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(MOBILE_FILE_PREVIEW_LINE_NUMBERS_STORAGE_KEY, String(value))
  } catch {
    // Ignore storage write errors on mobile
  }
}

export function useMobileLineNumbersPreference(): [
  boolean,
  (value: boolean | ((prev: boolean) => boolean)) => void
] {
  const [showLineNumbers, setShowLineNumbersState] = useState<boolean>(true)

  useEffect(() => {
    let stale = false
    void readMobileLineNumbersPreference().then((value) => {
      if (!stale) {
        setShowLineNumbersState(value)
      }
    })
    return () => {
      stale = true
    }
  }, [])

  const setShowLineNumbers = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      setShowLineNumbersState((prev) => {
        const next = typeof value === 'function' ? value(prev) : value
        void writeMobileLineNumbersPreference(next)
        return next
      })
    },
    []
  )

  return [showLineNumbers, setShowLineNumbers]
}
