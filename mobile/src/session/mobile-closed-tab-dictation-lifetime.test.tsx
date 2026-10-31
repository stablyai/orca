import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer } from './native-chat/composer/MobileNativeChatComposer'
import { captureMobileNativeChatTextDestination } from './native-chat/composer/mobile-native-chat-draft-inputs'
import {
  closeMobileNativeChatTabDraft,
  readMobileNativeChatDraftEditGeneration,
  resetMobileNativeChatDraftStoreForTests,
  setMobileNativeChatDraftText
} from './native-chat/composer/mobile-native-chat-draft-store'
import { findByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    AccessibilityInfo: { announceForAccessibilityWithOptions: vi.fn() },
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ListEnd: 'ListEnd',
  CornerDownRight: 'CornerDownRight',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  FileText: 'FileText',
  Mic: 'Mic',
  Package: 'Package',
  Plus: 'Plus',
  ShieldAlert: 'ShieldAlert',
  Square: 'Square',
  Terminal: 'Terminal',
  X: 'X'
}))
vi.mock('../components/mounted-bottom-drawer', () => ({ MountedBottomDrawer: 'BottomDrawer' }))
vi.mock('../components/bottom-drawer-modal-host-scope', () => ({
  useBottomDrawerModalHost: () => null
}))

let renderer: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  resetMobileNativeChatDraftStoreForTests()
})

it.each([false, true])(
  'rejects captured dictation after tab retirement with custom insert=%s',
  async (customInsert) => {
    const scope = `retired-dictation-${customInsert}`
    const insertDictation = vi.fn(() => true)
    setMobileNativeChatDraftText(scope, 'old text')
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: 'old text',
          draftScopeKey: scope,
          insertDictation: customInsert ? insertDictation : undefined,
          onChangeText: vi.fn(),
          onSend: async () => true,
          sendSurfaceId: scope,
          getSendCompletionGeneration: () => 0,
          getComposerEditGeneration: () => 0
        })
      )
    })
    act(() => findByHostType(renderer!.root, 'TextInput').props.onFocus())
    const insert = captureMobileNativeChatTextDestination()?.insert
    if (!insert) {
      throw new Error('composer did not register dictation')
    }
    act(() => {
      insert('live dictation')
    })
    if (customInsert) {
      expect(insertDictation).toHaveBeenCalledOnce()
    } else {
      expect(readMobileNativeChatDraftEditGeneration(scope)).toBe(2)
    }
    insertDictation.mockClear()
    await act(async () => closeMobileNativeChatTabDraft(scope))
    expect(insert('late dictation')).toBe(false)
    expect(insertDictation).not.toHaveBeenCalled()
    expect(readMobileNativeChatDraftEditGeneration(scope)).toBe(0)
  }
)
