import { createElement, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  useMobileNativeChatDraft,
  setMobileNativeChatDraftText
} from './mobile-native-chat-draft-store'

import { MobileNativeChatComposer as NativeChatComposer } from './MobileNativeChatComposer'
import { findByHostType } from '../../../test-support/react-test-renderer-host-nodes'

import { captureMobileNativeChatTextDestination } from './mobile-native-chat-draft-inputs'

const getNoComposerEditGeneration = () => 0

function MobileNativeChatComposer({
  getComposerEditGeneration = getNoComposerEditGeneration,
  ...props
}: Omit<ComponentProps<typeof NativeChatComposer>, 'getComposerEditGeneration'> & {
  getComposerEditGeneration?: () => number
}): React.JSX.Element {
  return createElement(NativeChatComposer, { ...props, getComposerEditGeneration })
}

vi.mock('../../../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('./MobileNativeChatContextUsageRing', () => ({
  useMobileNativeChatContextRing: () => ({ barProps: {}, ring: null })
}))
// BottomDrawer also carries the option pager, which loads Reanimated at import.
vi.mock('react-native-reanimated', async () =>
  (await import('../../../test-support/reanimated-pager-stub')).reanimatedPagerStub()
)
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ...(await import('../../../test-support/react-native-motion-stub')).reactNativeMotionStub(),
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

vi.mock('../../../components/bottom-drawer/mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'BottomDrawer'
}))
vi.mock('../../../components/bottom-drawer/bottom-drawer-modal-host-scope', () => ({
  useBottomDrawerModalHost: () => null
}))

describe('MobileNativeChatComposer', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('appends dictation until a selection is read, then replaces the selection it started on', async () => {
    const scope = 'dictation-ordinary'
    setMobileNativeChatDraftText(scope, 'Ok')
    function Registered() {
      const value = useMobileNativeChatDraft(scope)
      return createElement(MobileNativeChatComposer, {
        value,
        draftScopeKey: scope,
        onChangeText: (text) => setMobileNativeChatDraftText(scope, text),
        onSend: async () => true,
        sendSurfaceId: scope,
        getSendCompletionGeneration: () => 0
      })
    }
    await act(async () => {
      renderer = create(createElement(Registered))
    })
    const input = () => findByHostType(renderer!.root, 'TextInput')
    const say = (text: string) =>
      act(() => void captureMobileNativeChatTextDestination()!.insert(text))
    const select = (start: number, end: number) =>
      input().props.onSelectionChange({ nativeEvent: { selection: { start, end }, text: 'Ok hi' } })
    act(() => input().props.onFocus())
    say('hi')
    act(() => select(3, 5))
    const destination = captureMobileNativeChatTextDestination()!
    // A tap elsewhere while talking doesn't move where the words land.
    act(() => {
      select(0, 0)
      destination.insert('there')
    })
    expect(input().props.value).toBe('Ok there')
    say('now')
    expect(input().props.value).toBe('Ok there now')
  })
})
