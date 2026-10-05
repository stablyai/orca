import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NativeChatSettingsScreen from './native-chat-settings-screen'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Switch: 'Switch'
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn() }) }))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'ChevronLeft' }))
vi.mock('../theme/mobile-theme', () => ({ colors: {}, radii: {}, spacing: {}, typography: {} }))
vi.mock('../session/use-mobile-default-session-view-preference', () => ({
  useMobileDefaultSessionViewPreference: () => ({
    defaultView: 'terminal',
    setDefaultView: vi.fn()
  })
}))

describe('Chat UI settings copy (A1c-11)', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('describes the default without promising that a switched session keeps its view', () => {
    act(() => {
      renderer = create(createElement(NativeChatSettingsScreen, {}))
    })
    const copy = renderer!.root
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => [node.props.children].flat().join(''))
      .map((text) => text.replace(/\s+/g, ' ').trim())
    expect(copy).toContain(
      'Choose how sessions started as Claude, Codex, or another chat-capable agent open on this device. You can switch a supported session from its long-press menu.'
    )
  })
})
