import { describe, expect, it, vi, beforeAll } from 'vitest'
import React from 'react'

// Why: init.ts imports expo-localization (used at module top-level via
// `Localization.getLocales?.()`). The real module pulls in expo-modules-core
// which references the RN global `__DEV__` — undefined in node. A surface
// mock matches what init.test.ts already does and is enough for the i18n flow.
// (react-native itself is aliased to test/rn-shim.tsx via vitest.config —
// Flow syntax in its real CJS bundle can't be parsed by node.)
vi.mock('expo-localization', () => ({
  getLocales: () => [
    {
      languageCode: 'en',
      languageTag: 'en-US',
      regionCode: 'US',
      textDirection: 'ltr',
      decimalSeparator: '.',
      digitGroupingSeparator: ','
    }
  ]
}))

import { render, screen, waitFor } from '@testing-library/react-native'
import { Text } from 'react-native'

import { initI18n, getI18n } from './init'
import { I18nProvider } from './I18nProvider'
import { T } from './T'

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nProvider i18n={getI18n()}>{ui}</I18nProvider>)
}

beforeAll(async () => {
  await initI18n('en')
})

describe('<T>', () => {
  it('renders children as fallback when no i18nKey is given', () => {
    renderWithI18n(<T>Settings</T>)
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('translates via i18nKey when the key exists', () => {
    renderWithI18n(<T i18nKey="settings.title">Settings</T>)
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('falls back to children when the i18nKey is missing', () => {
    renderWithI18n(<T i18nKey="does.not.exist">My fallback</T>)
    expect(screen.getByText('My fallback')).toBeTruthy()
  })

  it('re-renders when language changes', async () => {
    const { rerender } = renderWithI18n(<T i18nKey="settings.title">Settings</T>)
    expect(screen.getByText('Settings')).toBeTruthy()

    await getI18n().changeLanguage('zh')

    rerender(
      <I18nProvider i18n={getI18n()}>
        <T i18nKey="settings.title">Settings</T>
      </I18nProvider>
    )

    await waitFor(() => {
      expect(screen.getByText('设置')).toBeTruthy()
    })
  })

  it('forwards TextProps (style, numberOfLines)', () => {
    renderWithI18n(
      <T style={{ color: 'red' }} numberOfLines={1}>
        Settings
      </T>
    )
    const node = screen.getByText('Settings')
    expect(node.props.style).toMatchObject({ color: 'red' })
    expect(node.props.numberOfLines).toBe(1)
  })

  it('composes with sibling Text nodes inside the same parent', () => {
    renderWithI18n(
      <>
        <T>Settings</T>
        <Text>·</Text>
        <T i18nKey="settings.title">Settings</T>
      </>
    )
    expect(screen.getByText('Settings')).toBeTruthy()
    expect(screen.getByText('·')).toBeTruthy()
  })
})
