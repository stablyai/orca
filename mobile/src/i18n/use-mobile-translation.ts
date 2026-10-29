import { useMemo, useSyncExternalStore } from 'react'
import type { SupportedUiLocale } from '../../../src/shared/ui-locale'
import {
  getMobileUiLocale,
  getMobileUiRevision,
  subscribeMobileUiLanguage,
  translate,
  type Translate
} from './mobile-i18n'

// Call in every component that renders translated text. The returned function changes identity
// with the language, so memos and callbacks that list it as a dependency recompute.
export function useMobileTranslation(): Translate {
  const revision = useSyncExternalStore(subscribeMobileUiLanguage, getMobileUiRevision)
  return useMemo<Translate>(
    () => (key, fallback, options) => translate(key, fallback, options),
    [revision]
  )
}

export function useMobileUiLocale(): SupportedUiLocale {
  return useSyncExternalStore(subscribeMobileUiLanguage, getMobileUiLocale)
}
