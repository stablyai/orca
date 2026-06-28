// Why: `children` doubles as the English fallback string AND the i18next
// defaultValue. TypeScript requires children to be a string literal, so each
// <T> usage has a known fallback at compile time — no missing-key mystery.
//
// Unit tests skipped: this codebase has no React Native component testing
// infrastructure set up (no @testing-library/react-native, no RN Jest preset).
// The component's behaviour is validated end-to-end via the smoke check in
// docs/superpowers/plans/2026-06-28-mobile-i18n.md Task 17.
import { useTranslation } from 'react-i18next'
import { Text, type TextProps } from 'react-native'

export type TProps = Omit<TextProps, 'children'> & {
  /** Optional translation key. If omitted, renders `children` directly. */
  i18nKey?: string
  /** English fallback. Also serves as i18next defaultValue. */
  children: string
  /** Interpolation values passed to t() */
  values?: Record<string, string | number>
  /** Namespace, defaults to 'translation' */
  ns?: string
}

export function T({ i18nKey, children, values, ns, ...rest }: TProps) {
  const { t } = useTranslation(ns ? [ns] : undefined)
  if (i18nKey) {
    const translated = t(i18nKey, { defaultValue: children, ...values })
    return <Text {...rest}>{translated}</Text>
  }
  return <Text {...rest}>{children}</Text>
}
