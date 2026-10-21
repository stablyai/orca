import type { TOptions } from 'i18next'
import { mainI18n, translateMain } from '../i18n/main-i18n'
import { isPseudoLocalizationLocale } from '../../shared/pseudo-localization'

export function nativeRoleLabel(
  key: string,
  fallback: string,
  options?: TOptions
): string | undefined {
  const locale = mainI18n.language
  // Let Electron supply its native label when a partial catalog has no translation.
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
