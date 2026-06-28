// Why: `children` doubles as the English fallback string AND the i18next
// defaultValue. TypeScript requires children to be a string literal, so each
// <T> usage has a known fallback at compile time — no missing-key mystery.
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
