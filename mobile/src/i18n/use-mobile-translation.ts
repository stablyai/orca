import { useSyncExternalStore } from 'react'
import type { SupportedUiLocale } from '../../../src/shared/i18n/ui-locale'
import {
  getMobileUiLocale,
  getMobileUiRevision,
  subscribeMobileUiLanguage,
  translate,
  type Translate
} from './mobile-i18n'

let current: { revision: number; t: Translate } | undefined

// The revision is an argument, not read here, so React Compiler recomputes callers exactly when it changes;
// a useMemo whose callback never read it would keep one identity forever once compiled.
function translatorFor(revision: number): Translate {
  if (current?.revision !== revision) {
    current = { revision, t: (key, fallback, options) => translate(key, fallback, options) }
  }
  return current.t
}

// Call in every component that renders translated text. The returned function changes identity
// with the language, so memos and callbacks that list it as a dependency recompute.
export function useMobileTranslation(): Translate {
  return translatorFor(useSyncExternalStore(subscribeMobileUiLanguage, getMobileUiRevision))
}

export function useMobileUiLocale(): SupportedUiLocale {
  return useSyncExternalStore(subscribeMobileUiLanguage, getMobileUiLocale)
}
