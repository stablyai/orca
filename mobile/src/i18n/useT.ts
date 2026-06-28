// Why: some screens need translation in event handlers or non-render logic,
// where a hook is more ergonomic than reaching for getI18n() directly.
//
// Unit tests skipped: see T component — this codebase has no React Native
// component testing infrastructure. useT's behaviour is validated
// end-to-end via Task 17 (smoke check).
import { useTranslation } from 'react-i18next'

import type { MobileResolvedLanguage } from './init'

export function useT() {
  const { t, i18n } = useTranslation()
  return {
    t,
    resolvedLanguage: i18n.language as MobileResolvedLanguage
  }
}
