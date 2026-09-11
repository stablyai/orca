// Why: expo-localization is a native module with no Node implementation, and
// mobile-i18n reads the system locale at module scope. vitest.config.ts aliases the
// package here so importing the module under test does not require a device.
export function getLocales(): { languageTag: string }[] {
  return [{ languageTag: 'en' }]
}

export function useLocales(): { languageTag: string }[] {
  return getLocales()
}
