import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import TerminalSettingsScreen from '../../app/terminal-settings'
import { PickerModal } from '../components/PickerModal'

const storage = vi.hoisted(
  (): {
    values: Map<string, string>
    firstTextRead?: Promise<string | null>
  } => ({ values: new Map() })
)

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      if (key === 'orca:terminalTextScale' && storage.firstTextRead) {
        const pending = storage.firstTextRead
        storage.firstTextRead = undefined
        return pending
      }
      return storage.values.get(key) ?? null
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.values.set(key, value)
    })
  }
}))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Switch: 'Switch',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: 'View' }))
vi.mock('react-native-reanimated', () => ({
  default: { ScrollView: 'ScrollView' },
  useAnimatedRef: () => ({ current: null }),
  useSharedValue: (value: number) => ({ value }),
  useAnimatedScrollHandler: () => () => {}
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ back() {} }) }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  ChevronRight: 'Icon',
  Smartphone: 'Icon',
  Type: 'Icon'
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: () => null }))
vi.mock('../components/TerminalShortcutSettings', () => ({ TerminalShortcutSettings: () => null }))
vi.mock('../transport/host-store', () => ({ loadHosts: async () => [] }))
vi.mock('../transport/settings-host-client-connections', () => ({
  useFocusedSettingsHostClients: () => ({ clients: [], focused: true })
}))
vi.mock('../terminal/terminal-settings-scroll-lock', () => ({
  setTerminalSettingsScrollEnabled() {}
}))

let renderer: ReactTestRenderer
afterEach(() => {
  act(() => renderer?.unmount())
  storage.firstTextRead = undefined
  storage.values.clear()
  vi.clearAllMocks()
})

describe('terminal settings text-size hydration', () => {
  it('keeps a saved user selection when the older storage read finishes', async () => {
    let resolveInitialRead: (value: string) => void = () => {}
    storage.firstTextRead = new Promise((resolve) => {
      resolveInitialRead = resolve
    })
    await act(async () => {
      renderer = create(createElement(TerminalSettingsScreen))
    })
    const picker = () =>
      renderer.root
        .findAllByType(PickerModal)
        .find((node) => node.props.title === 'Terminal text size')!
    expect(picker().props.selected).toBe('default')

    await act(async () => {
      picker().props.onSelect('larger')
    })
    expect(picker().props.selected).toBe('larger')
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('orca:terminalTextScale', '1.5')
    expect(storage.values.get('orca:terminalTextScale')).toBe('1.5')

    await act(async () => {
      resolveInitialRead('0.75')
    })
    expect(picker().props.selected).toBe('larger')
    expect(JSON.stringify(renderer.toJSON())).toContain('Larger (150%)')
  })

  it('still hydrates the saved size when the user has not edited it', async () => {
    storage.values.set('orca:terminalTextScale', '0.75')
    await act(async () => {
      renderer = create(createElement(TerminalSettingsScreen))
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('Smaller (75%)')
  })
})
