// @vitest-environment jsdom
// Why: react-test-renderer isn't a mobile dep, and @testing-library/react-hooks
// (8.0.1) was the previous workaround but only in jest@29 resolution and not
// guaranteed to keep working under vitest+react@19. Render via react-dom's
// createRoot + act() which is already in mobile/node_modules (react-dom is a
// peer dep for the editor preview surface). The test component just renders
// the hook's return value so we can read it back.
//
// Why the explicit `import { act } from 'react'` rather than `react-dom/test-utils`:
// react-dom's test-utils require a global IS_REACT_ACT_ENVIRONMENT flag, and
// react@19 exposes `act` directly. Simpler setup.
//
// Why the `@vitest-environment jsdom` directive: vitest's mobile config sets
// environment: 'node' globally (no DOM) to keep test startup fast. This single
// file needs DOM access for `document.createElement('div')`, so we opt in
// per-file. jsdom is already in mobile's transitive deps.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('expo-localization', () => ({
  getLocales: vi.fn()
}))

import { useTranslate } from '../useTranslate'
import { initI18n } from '../init'

beforeEach(async () => {
  await initI18n('zh')
})

function HookHost({ onResult }: { onResult: (r: ReturnType<typeof useTranslate>) => void }) {
  const result = useTranslate()
  useEffect(() => {
    onResult(result)
  })
  return null
}

describe('useTranslate()', () => {
  it('returns { t, resolvedLanguage } with the active language', async () => {
    const container = document.createElement('div')
    let root: Root | null = null
    let captured: ReturnType<typeof useTranslate> | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(HookHost, { onResult: (r) => (captured = r) }))
    })

    expect(captured).not.toBeNull()
    expect(captured!.resolvedLanguage).toBe('zh')

    // t() must wrap defaultValue so missing keys fall back to English.
    expect(captured!.t('mobile.nonexistent.key', 'Fallback')).toBe('Fallback')

    // Hit path: a key that does exist in zh.json returns the localized value.
    expect(captured!.t('mobile.settings.title', 'Settings')).toBe('设置')

    act(() => {
      root!.unmount()
    })
  })
})
