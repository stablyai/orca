import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import NotificationsScreen from './notification-settings-screen'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Switch: 'Switch',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (value: unknown) => value },
  AppState: { addEventListener: () => ({ remove() {} }) }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback])
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon' }))
let renderer: ReactTestRenderer
afterEach(() => act(() => renderer?.unmount()))

it('keeps a successful notification choice when the older focus read finishes last', async () => {
  let resolveRead = (_value: { enabled: boolean }) => {}
  const permission = {
    granted: true,
    status: 'granted',
    canAskAgain: true,
    authorizationReflectsUserChoice: true
  }
  const operations = {
    permission: vi.fn().mockResolvedValue(permission),
    preference: vi.fn((enabled?: boolean): Promise<{ enabled: boolean }> =>
      enabled === undefined
        ? new Promise((resolve) => {
            resolveRead = resolve
          })
        : Promise.resolve({ enabled })
    ),
    openSettings: vi.fn()
  }
  await act(async () => {
    renderer = create(createElement(NotificationsScreen, { operations, onBack() {} }))
  })
  const toggle = () => renderer.root.findByProps({ testID: 'notification-enabled' }).props
  await act(async () => {
    await toggle().onValueChange(true)
  })
  expect(toggle().value).toBe(true)
  await act(async () => {
    resolveRead({ enabled: false })
  })
  expect(toggle().value).toBe(true)
})
