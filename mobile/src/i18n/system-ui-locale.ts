import { getLocales } from 'expo-localization'
import {
  DEFAULT_UI_LOCALE,
  matchUiLocaleParts,
  type SupportedUiLocale,
  type UiLocaleParts
} from '../../../src/shared/ui-locale'

// Hermes has no Intl.Locale: read script (4 letters) and region (2 letters or 3 digits) subtags directly.
export function parseUiLocaleTag(tag: string): UiLocaleParts | null {
  const [language, ...subtags] = tag.trim().replace(/_/g, '-').split('-')
  if (!/^[a-z]{2,3}$/i.test(language ?? '')) {
    return null
  }
  const script = subtags.find((subtag, index) => index === 0 && /^[a-z]{4}$/i.test(subtag))
  const region = subtags
    .slice(script ? 1 : 0, script ? 2 : 1)
    .find((subtag) => /^(?:[a-z]{2}|\d{3})$/i.test(subtag))
  return { language, script: script ?? null, region: region ?? null }
}

// Walk the whole preference list: a phone set to Italian, then Japanese, should get Japanese.
export function resolveUiLocaleFromTags(tags: readonly string[]): SupportedUiLocale {
  for (const tag of tags) {
    const parts = parseUiLocaleTag(tag)
    const match = parts ? matchUiLocaleParts(parts) : null
    if (match) {
      return match
    }
  }
  return DEFAULT_UI_LOCALE
}

export function readDeviceUiLocaleTags(): string[] {
  try {
    return getLocales().map((locale) => locale.languageTag)
  } catch {
    return []
  }
}
