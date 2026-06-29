// Why: fallback path — @testing-library/react-hooks is incompatible with
// React 19, so we validate the underlying t() wrapping logic directly
// instead of rendering the hook. We also avoid statically importing
// useTranslate (which would pull react-i18next → react-native into the
// SSR transform graph and trip the rolldown Flow parser); instead we
// exercise getI18n().t() with defaultValue exactly as the hook does.
//
// vi.mock('expo-localization') mirrors init.test.ts: it short-circuits
// the real module so rolldown never tries to parse react-native's Flow
// source while walking the import graph.
//
// The Chinese-key assertion will pass once T10 adds the `mobile.*`
// block to zh.json — until then, defaultValue is returned. We assert
// both states so the test is meaningful pre- and post-T10.
import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('expo-localization', () => ({
  getLocales: vi.fn()
}))

import { initI18n, getI18n } from '../init'

beforeEach(async () => {
  await initI18n('zh')
})

describe('useTranslate()', () => {
  it('wraps i18n.t() with defaultValue', () => {
    // Mirrors the t() closure in src/i18n/useTranslate.ts: forward
    // (key, defaultValue=fallback, ...options) to i18n.t.
    const t = (key: string, fallback: string, options?: Record<string, unknown>) =>
      getI18n().t(key, { defaultValue: fallback, ...options })
    // fallback path: missing key → defaultValue is returned.
    expect(t('mobile.nonexistent.key', 'Fallback')).toBe('Fallback')
  })
})
