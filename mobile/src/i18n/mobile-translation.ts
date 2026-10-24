const MOBILE_TRANSLATIONS: Record<string, string> = {}

/** Intent-named ids stay stable; English is the fallback until a mobile catalog ships. */
export function translate(id: string, fallback: string): string {
  return MOBILE_TRANSLATIONS[id] ?? fallback
}

export function useMobileTranslation(): {
  translate: (id: string, fallback: string) => string
} {
  return { translate }
}
