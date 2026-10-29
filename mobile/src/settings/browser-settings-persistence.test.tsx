import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrowserSettingsScreen from './browser-settings-screen'
import { PickerModal } from '../components/PickerModal'
import {
  loadTerminalLinkOpenMode,
  saveTerminalLinkOpenMode,
  type MobileTerminalLinkOpenMode
} from '../storage/preferences'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ back() {} }) }))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', ChevronRight: 'Icon', Globe: 'Icon' }))
vi.mock('../components/PickerModal', () => ({ PickerModal: () => null }))
vi.mock('../storage/preferences', () => ({
  loadTerminalLinkOpenMode: vi.fn(),
  saveTerminalLinkOpenMode: vi.fn()
}))
let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  vi.resetAllMocks()
})

describe('browser settings persistence', () => {
  it('does not replace a new selection with an older pending hydration read', async () => {
    let resolveLoad = (_value: MobileTerminalLinkOpenMode) => {}
    vi.mocked(loadTerminalLinkOpenMode).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        })
    )
    vi.mocked(saveTerminalLinkOpenMode).mockResolvedValue()
    await act(async () => {
      renderer = create(createElement(BrowserSettingsScreen))
    })
    await act(async () => {
      renderer.root.findByType(PickerModal).props.onSelect('phone-browser')
    })
    await act(async () => {
      resolveLoad('orca-browser')
    })
    expect(renderer.root.findByType(PickerModal).props.selected).toBe('phone-browser')
    expect(JSON.stringify(renderer.toJSON())).toContain('Phone browser')
  })

  it('restores the saved destination when changing the destination fails', async () => {
    vi.mocked(loadTerminalLinkOpenMode).mockResolvedValue('orca-browser')
    vi.mocked(saveTerminalLinkOpenMode).mockRejectedValue(new Error('storage unavailable'))
    await act(async () => {
      renderer = create(createElement(BrowserSettingsScreen))
    })
    await act(async () => {
      renderer.root.findByType(PickerModal).props.onSelect('phone-browser')
    })
    expect(renderer.root.findByType(PickerModal).props.selected).toBe('orca-browser')
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not save browser preferences')
  })

  it('restores the hydrated destination when the save fails before the first read finishes', async () => {
    let resolveLoad = (_value: MobileTerminalLinkOpenMode) => {}
    vi.mocked(loadTerminalLinkOpenMode).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        })
    )
    vi.mocked(saveTerminalLinkOpenMode).mockRejectedValue(new Error('storage unavailable'))
    await act(async () => {
      renderer = create(createElement(BrowserSettingsScreen))
    })
    await act(async () => {
      renderer.root.findByType(PickerModal).props.onSelect('orca-browser')
    })
    await act(async () => resolveLoad('phone-browser'))
    expect(renderer.root.findByType(PickerModal).props.selected).toBe('phone-browser')
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not save browser preferences')
  })
})
