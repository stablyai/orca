import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

export type MobileMarkdownViewMode = 'editor' | 'source'

export const MOBILE_MARKDOWN_VIEW_MODE_STORAGE_KEY = 'orca:mobile:markdown:view-mode'
export const MOBILE_MARKDOWN_DOC_VIEW_MODES_STORAGE_KEY = 'orca:mobile:markdown:doc-view-modes'

const MAX_REMEMBERED_DOCUMENTS = 50
const docViewModes = new Map<string, MobileMarkdownViewMode>()
const docScrollRatios = new Map<string, number>()
let lastChosenMode: MobileMarkdownViewMode = 'editor'
let storageHydrated = false

export function getMobileMarkdownScrollRatio(docKey?: string | null): number {
  if (docKey && docScrollRatios.has(docKey)) {
    return docScrollRatios.get(docKey)!
  }
  return 0
}

export function saveMobileMarkdownScrollRatio(
  docKey: string | undefined | null,
  ratio: number
): void {
  if (!docKey || typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    return
  }
  const clamped = Math.max(0, Math.min(1, ratio))
  docScrollRatios.delete(docKey)
  docScrollRatios.set(docKey, clamped)
  while (docScrollRatios.size > MAX_REMEMBERED_DOCUMENTS) {
    const oldestKey = docScrollRatios.keys().next().value
    if (typeof oldestKey !== 'string') {
      break
    }
    docScrollRatios.delete(oldestKey)
  }
}

export function parseMobileMarkdownViewMode(raw: unknown): MobileMarkdownViewMode {
  return raw === 'source' ? 'source' : 'editor'
}

export function getInitialMobileMarkdownViewMode(docKey?: string | null): MobileMarkdownViewMode {
  if (docKey && docViewModes.has(docKey)) {
    return docViewModes.get(docKey)!
  }
  return lastChosenMode
}

export function saveMobileMarkdownViewMode(
  docKey: string | undefined | null,
  mode: MobileMarkdownViewMode
): Promise<void> {
  lastChosenMode = mode
  if (docKey) {
    docViewModes.delete(docKey)
    docViewModes.set(docKey, mode)
    while (docViewModes.size > MAX_REMEMBERED_DOCUMENTS) {
      const oldestKey = docViewModes.keys().next().value
      if (typeof oldestKey !== 'string') {
        break
      }
      docViewModes.delete(oldestKey)
    }
  }

  return writePreferences(lastChosenMode, docViewModes)
}

async function writePreferences(
  defaultMode: MobileMarkdownViewMode,
  docMap: Map<string, MobileMarkdownViewMode>
): Promise<void> {
  try {
    await AsyncStorage.setItem(MOBILE_MARKDOWN_VIEW_MODE_STORAGE_KEY, defaultMode)
    const serialized = JSON.stringify(Array.from(docMap.entries()))
    await AsyncStorage.setItem(MOBILE_MARKDOWN_DOC_VIEW_MODES_STORAGE_KEY, serialized)
  } catch {
    // Ignore storage write errors on mobile
  }
}

export async function readMobileMarkdownViewModePreferences(): Promise<void> {
  try {
    const [rawMode, rawDocModes] = await Promise.all([
      AsyncStorage.getItem(MOBILE_MARKDOWN_VIEW_MODE_STORAGE_KEY),
      AsyncStorage.getItem(MOBILE_MARKDOWN_DOC_VIEW_MODES_STORAGE_KEY)
    ])
    if (rawMode) {
      lastChosenMode = parseMobileMarkdownViewMode(rawMode)
    }
    if (rawDocModes) {
      const entries = JSON.parse(rawDocModes) as unknown
      if (Array.isArray(entries)) {
        for (const item of entries) {
          if (Array.isArray(item) && typeof item[0] === 'string') {
            if (!docViewModes.has(item[0])) {
              docViewModes.set(item[0], parseMobileMarkdownViewMode(item[1]))
            }
          }
        }
      }
    }
  } catch {
    // Fall back to current in-memory values
  } finally {
    storageHydrated = true
  }
}

export function clearMobileMarkdownViewModeState(): void {
  docViewModes.clear()
  docScrollRatios.clear()
  lastChosenMode = 'editor'
  storageHydrated = false
}

export function useMobileMarkdownViewMode(
  docKey?: string | null
): [
  MobileMarkdownViewMode,
  (mode: MobileMarkdownViewMode | ((prev: MobileMarkdownViewMode) => MobileMarkdownViewMode)) => void
] {
  const [viewMode, setViewModeState] = useState<MobileMarkdownViewMode>(() =>
    getInitialMobileMarkdownViewMode(docKey)
  )

  useEffect(() => {
    setViewModeState(getInitialMobileMarkdownViewMode(docKey))
  }, [docKey])

  useEffect(() => {
    if (storageHydrated) {
      return
    }
    let stale = false
    void readMobileMarkdownViewModePreferences().then(() => {
      if (!stale) {
        setViewModeState(getInitialMobileMarkdownViewMode(docKey))
      }
    })
    return () => {
      stale = true
    }
  }, [docKey])

  const setViewMode = useCallback(
    (
      value:
        | MobileMarkdownViewMode
        | ((prev: MobileMarkdownViewMode) => MobileMarkdownViewMode)
    ) => {
      setViewModeState((prev) => {
        const next = typeof value === 'function' ? value(prev) : value
        saveMobileMarkdownViewMode(docKey, next)
        return next
      })
    },
    [docKey]
  )

  return [viewMode, setViewMode]
}
