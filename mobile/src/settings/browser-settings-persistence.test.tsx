import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BrowserSettingsScreen from './browser-settings-screen'
import { PickerModal } from '../components/sheets/PickerModal'
import {
  loadBrowserDrawing,
  loadLinkOpenMode,
  saveLinkOpenMode,
  type MobileLinkOpenMode
} from '../storage/preferences'

vi.mock(
  './settings-screen-frame',
  async () => (await import('../test-support/settings-chrome-test-double')).settingsFrameDouble
)
vi.mock(
  '../components/list/ListGroup',
  async () => (await import('../test-support/settings-chrome-test-double')).listGroupDouble
)
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
vi.mock('../components/sheets/PickerModal', () => ({ PickerModal: () => null }))
vi.mock('../storage/preferences', () => ({
  DEFAULT_LINK_OPEN_MODE: 'ask',
  DEFAULT_BROWSER_DRAWING: 'host',
  loadLinkOpenMode: vi.fn(),
  saveLinkOpenMode: vi.fn(),
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
    let resolveLoad = (_value: MobileLinkOpenMode) => {}
    vi.mocked(loadLinkOpenMode).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        })
    )
    vi.mocked(saveLinkOpenMode).mockResolvedValue()
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
  })

  it('restores the hydrated destination when the save fails before the first read finishes', async () => {
    let resolveLoad = (_value: MobileLinkOpenMode) => {}
    vi.mocked(loadLinkOpenMode).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        })
    )
    vi.mocked(saveLinkOpenMode).mockRejectedValue(new Error('storage unavailable'))
    await act(async () => {
      renderer = create(createElement(BrowserSettingsScreen))
    })
    await act(async () => {
      linkPicker().props.onSelect('orca-browser')
    })
    await act(async () => resolveLoad('phone-browser'))
    expect(linkPicker().props.selected).toBe('phone-browser')
  })
})
