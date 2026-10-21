import type { TOptions } from 'i18next'
import { mainI18n, translateMain } from '../i18n/main-i18n'
import { isPseudoLocalizationLocale } from '../../shared/pseudo-localization'

/** Preserves Electron's native label when a non-English, non-pseudo catalog lacks the key. */
export function nativeRoleLabel(
  key: string,
  fallback: string,
  options?: TOptions
): string | undefined {
  const locale = mainI18n.language
  if (
    locale &&
    locale !== 'en' &&
    !isPseudoLocalizationLocale(locale) &&
    typeof mainI18n.getResource(locale, 'translation', key) !== 'string'
  ) {
    return undefined
  }
  return translateMain(key, fallback, options)
}
