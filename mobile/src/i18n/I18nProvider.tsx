// Why: a thin wrapper so call sites don't need to import from react-i18next
// directly — keeps the import path consistent across screens.
import { I18nextProvider, type I18nextProviderProps } from 'react-i18next'

export function I18nProvider(props: I18nextProviderProps) {
  return <I18nextProvider {...props} />
}
