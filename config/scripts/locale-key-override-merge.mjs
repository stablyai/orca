import { CROSS_LOCALE_KEY_OVERRIDES } from './locale-cross-locale-key-overrides.mjs'

export function mergeLocaleKeyOverrides(base, extra) {
  const merged = { ...base }
  for (const [key, overrides] of Object.entries(CROSS_LOCALE_KEY_OVERRIDES)) {
    merged[key] = { ...merged[key], ...overrides }
  }
  for (const [key, overrides] of Object.entries(extra)) {
    // KO split overrides can share keys with zh/ja repairs; merge per locale.
    merged[key] = { ...merged[key], ...overrides }
  }
  return merged
}
