import { createElement, Fragment } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import {
  applyMobileColorScheme,
  getMobileColorScheme,
  lightColors,
  darkColors
} from '../theme/mobile-theme'

const device = vi.hoisted(() => ({
  scheme: 'light',
  change: () => {},
  storage: new Map<string, string>()
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: () => ({ remove() {} }) },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  Appearance: {
    setColorScheme: vi.fn(),
    getColorScheme: () => device.scheme,
    addChangeListener: (callback: () => void) => {
      device.change = callback
      return { remove() {} }
    }
  }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => device.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      device.storage.set(key, value)
    },
    removeItem: async (key: string) => {
      device.storage.delete(key)
    }
  }
}))
import { AppUpdateSettingsRows } from './app-update-settings-rows'
import { MobileAppearanceSettings } from './mobile-appearance-settings'

it('offers three choices, persists selection and only follows the system when selected', async () => {
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(
      createElement(
        Fragment,
        null,
        createElement(MobileAppearanceSettings),
        createElement(AppUpdateSettingsRows, {
          installedVersion: '0.0.55',
          available: null,
          lastCheckedAt: null,
          now: 0,
          checkStatus: 'idle',
          onCheck() {},
          onUpdate() {}
        })
      )
    )
  })
  try {
    const choices = () =>
      tree.root.findAll(
        (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'radio'
      )
    expect(choices().map((node) => node.props.accessibilityLabel)).toEqual([
      'Follow system',
      'Dark',
      'Light'
    ])
    const versionColor = () =>
      tree.root.find(
        (node) => String(node.type) === 'Text' && node.props.children[0] === 'Version '
      ).props.style.color
    expect(versionColor()).toBe(lightColors.textPrimary)
    expect(choices()[0].props.accessibilityState.checked).toBe(true)
    await act(async () => choices()[2].props.onPress())
    expect(device.storage.get('orca:appearance')).toBe('light')
    act(() => {
      device.scheme = 'dark'
      device.change()
    })
    expect(getMobileColorScheme()).toBe('light')
    expect(versionColor()).toBe(lightColors.textPrimary)
    await act(async () => choices()[0].props.onPress())
    expect(getMobileColorScheme()).toBe('dark')
    expect(versionColor()).toBe(darkColors.textPrimary)
    expect(device.storage.get('orca:appearance')).toBe('system')
  } finally {
    act(() => tree.unmount())
    applyMobileColorScheme('dark')
  }
})
