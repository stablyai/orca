import './plural-rules-polyfill'
import i18next, { type TOptions } from 'i18next'
import { resolvePluralFamilyKey } from '../../../src/shared/i18n-plural-family'
import { pseudoLocalizeString } from '../../../src/shared/pseudo-localization'
import { DEFAULT_UI_LOCALE, type SupportedUiLocale } from '../../../src/shared/ui-locale'
import enRuntimeRequired from './en-runtime-required.json'
import { importLocaleCatalog } from './locale-catalog-imports'

export type Translate = (key: string, fallback: string, options?: TOptions) => string

export const mobileI18n = i18next.createInstance()

void mobileI18n.init({
  lng: DEFAULT_UI_LOCALE,
  fallbackLng: DEFAULT_UI_LOCALE,
  // Default 'all' expands zh-Hant to zh, so missing keys would render Simplified.
  load: 'currentOnly',
  initAsync: false,
  // Inline fallbacks carry English; the runtime subset keeps plural families and non-literal defaults.
  resources: { en: { translation: enRuntimeRequired } },
  partialBundledLanguages: true,
  returnEmptyString: false,
  interpolation: { escapeValue: false }
})

let activeLocale: SupportedUiLocale = DEFAULT_UI_LOCALE
let pseudoLocalization = false
let revision = 0
const listeners = new Set<() => void>()

// Bounded: re-rendered chrome resolves the same option-free strings repeatedly between language changes.
const PLAIN_TRANSLATION_CACHE_LIMIT = 4000
const plainTranslations = new Map<string, string>()

function publish(): void {
  revision += 1
  plainTranslations.clear()
  for (const listener of listeners) {
    listener()
  }
}

function translateUncached(key: string, fallback: string, options?: TOptions): string {
  const value = mobileI18n.t(resolvePluralFamilyKey(key, options), {
    defaultValue: fallback,
    ...options,
    // Catalog text never nests keys; interpolated values must not either.
    nest: false
  })
  return pseudoLocalization ? pseudoLocalizeString(value, { expand: true }) : value
}

// Same call shape as desktop, so extraction and catalog gates are shared.
export function translate(key: string, fallback: string, options?: TOptions): string {
  if (options !== undefined) {
    return translateUncached(key, fallback, options)
  }
  const cacheKey = `${key}\0${fallback}`
  const cached = plainTranslations.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const value = translateUncached(key, fallback)
  if (plainTranslations.size >= PLAIN_TRANSLATION_CACHE_LIMIT) {
    plainTranslations.clear()
  }
  plainTranslations.set(cacheKey, value)
  return value
}

export function getMobileUiLocale(): SupportedUiLocale {
  return activeLocale
}

export function getMobileUiRevision(): number {
  return revision
}

export function subscribeMobileUiLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let activationRequest = 0

// Latest request wins: an older catalog import that settles later must not replace a newer choice.
export async function activateMobileUiLocale(locale: SupportedUiLocale): Promise<void> {
  const request = ++activationRequest
  try {
    if (locale !== 'en' && !mobileI18n.hasResourceBundle(locale, 'translation')) {
      const catalog = await importLocaleCatalog(locale)
      if (!mobileI18n.hasResourceBundle(locale, 'translation')) {
        mobileI18n.addResourceBundle(locale, 'translation', catalog, false, true, {
          skipCopy: true
        })
      }
    }
    if (request !== activationRequest) {
      return
    }
    await mobileI18n.changeLanguage(locale)
    if (request !== activationRequest) {
      return
    }
    activeLocale = locale
  } catch (error) {
    if (request !== activationRequest) {
      return
    }
    console.warn('[i18n] Falling back to English', error)
    await mobileI18n.changeLanguage(DEFAULT_UI_LOCALE).catch(() => undefined)
    activeLocale = DEFAULT_UI_LOCALE
  }
  publish()
}

// Development-only layout check: accents and pads every string so clipping shows on device.
export function setMobilePseudoLocalization(enabled: boolean): void {
  if (pseudoLocalization !== enabled) {
    pseudoLocalization = enabled
    publish()
  }
}

export function isMobilePseudoLocalizationEnabled(): boolean {
  return pseudoLocalization
}
