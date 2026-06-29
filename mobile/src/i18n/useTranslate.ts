// Why: lets components subscribe to language changes and use the same
// t() in event handlers without a second call site.
import { useTranslation } from 'react-i18next'
import type { TOptions } from 'i18next'
import type { MobileResolvedLanguage } from './init'

export function useTranslate() {
  const { t, i18n } = useTranslation()
  return {
    t: (key: string, fallback: string, options?: TOptions) =>
      t(key, { defaultValue: fallback, ...options }),
    resolvedLanguage: i18n.language as MobileResolvedLanguage
  }
}
