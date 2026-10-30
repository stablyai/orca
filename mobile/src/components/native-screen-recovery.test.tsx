import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { NativeScreenRecovery } from './NativeScreenRecovery'
import { connectionLogStore } from '../transport/persisted-connection-log-store'
import { NATIVE_APP_LOG_ID } from '../diagnostics/native-render-log'

const navigation = vi.hoisted(() => ({ segments: ['about'] }))
vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: () => {} }),
  useSegments: () => navigation.segments
}))
vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

it('records the original failed route once when the unmounted layout resets router state', async () => {
  const props = { error: new Error('render failed'), retry: async () => {} }
  const mounted: { tree?: ReactTestRenderer } = {}
  await act(async () => {
    mounted.tree = create(createElement(NativeScreenRecovery, props))
  })
  const tree = mounted.tree
  if (!tree) {
    throw new Error('NativeScreenRecovery did not mount')
  }
  navigation.segments = []
  await act(async () => tree.update(createElement(NativeScreenRecovery, props)))
  const entries = connectionLogStore.get(NATIVE_APP_LOG_ID)
  expect(entries).toHaveLength(1)
  expect(entries[0]?.detail).toContain('/about: Error')
  await act(async () => tree.unmount())
})
