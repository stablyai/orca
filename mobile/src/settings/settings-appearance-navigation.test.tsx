import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import SettingsMenuScreen from './settings-menu-screen'
import AppearanceRoute from '../../app/appearance-settings'
import { getMobileColorScheme } from '../theme/mobile-theme'

const device = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  routes: new Array<string>()
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: () => ({ remove() {} }) },
  Appearance: {
    setColorScheme: vi.fn(),
    getColorScheme: () => 'light',
    addChangeListener: () => ({ remove() {} })
  },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn() }) }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({
  Bell: 'Bell',
  Globe: 'Globe',
  Info: 'Info',
  MessageSquare: 'MessageSquare',
  Mic: 'Mic',
  Palette: 'Palette',
  Terminal: 'Terminal',
  Wrench: 'Wrench',
  Shield: 'Shield',
  LifeBuoy: 'LifeBuoy',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight'
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => device.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      device.storage.set(key, value)
    }
  }
}))

it('opens Appearance from Settings and applies a saved mode through that route', async () => {
  let renderer: ReactTestRenderer | undefined
  function Navigation() {
    const [route, setRoute] = useState('/settings')
    return route === '/appearance-settings'
      ? createElement(AppearanceRoute)
      : createElement(SettingsMenuScreen, {
          push: (next: string) => {
            device.routes.push(next)
            setRoute(next)
          },
          openExternal: async () => {}
        })
  }
  try {
    await act(async () => {
      renderer = create(createElement(Navigation))
    })
    const entry = renderer!.root.find(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Appearance'
    )
    await act(async () => entry.props.onPress())
    expect(device.routes).toEqual(['/appearance-settings'])
    const choices = renderer!.root.findAll(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'radio'
    )
    expect(choices.map((choice) => choice.props.accessibilityLabel)).toEqual([
      'Follow system',
      'Dark',
      'Light'
    ])
    await act(async () => choices[1]!.props.onPress())
    expect(device.storage.get('orca:appearance')).toBe('dark')
    expect(getMobileColorScheme()).toBe('dark')
  } finally {
    act(() => renderer?.unmount())
  }
})
