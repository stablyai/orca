import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BrowserSettingsScreen from './browser-settings-screen'
import { PickerModal } from '../components/PickerModal'
import {
  loadBrowserDrawing,
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
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  ChevronRight: 'Icon',
  Globe: 'Icon',
  Network: 'Icon'
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: () => null }))
vi.mock('../storage/preferences', () => ({
  DEFAULT_TERMINAL_LINK_OPEN_MODE: 'orca-browser',
  DEFAULT_BROWSER_DRAWING: 'host',
  loadTerminalLinkOpenMode: vi.fn(),
  saveTerminalLinkOpenMode: vi.fn(),
  loadBrowserDrawing: vi.fn(),
  saveBrowserDrawing: vi.fn()
}))

function linkPicker() {
  return renderer.root.findAllByType(PickerModal)[0]!
}
let renderer: ReactTestRenderer

beforeEach(() => {
  vi.mocked(loadBrowserDrawing).mockResolvedValue('host')
})

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
      linkPicker().props.onSelect('phone-browser')
    })
    await act(async () => {
      resolveLoad('orca-browser')
    })
    expect(linkPicker().props.selected).toBe('phone-browser')
    expect(JSON.stringify(renderer.toJSON())).toContain('Phone browser')
  })

  it('restores the saved destination when changing the destination fails', async () => {
    vi.mocked(loadTerminalLinkOpenMode).mockResolvedValue('orca-browser')
    vi.mocked(saveTerminalLinkOpenMode).mockRejectedValue(new Error('storage unavailable'))
    await act(async () => {
      renderer = create(createElement(BrowserSettingsScreen))
    })
    await act(async () => {
      linkPicker().props.onSelect('phone-browser')
    })
    expect(linkPicker().props.selected).toBe('orca-browser')
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
      linkPicker().props.onSelect('orca-browser')
    })
    await act(async () => resolveLoad('phone-browser'))
    expect(linkPicker().props.selected).toBe('phone-browser')
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not save browser preferences')
  })
})
