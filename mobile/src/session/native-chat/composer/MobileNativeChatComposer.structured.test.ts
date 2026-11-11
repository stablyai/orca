import '../../../transport/rpc/rpc-delivery-ambiguity'
import { activateMobileUiLocale } from '../../../i18n/mobile-i18n'
import './use-mobile-native-chat-image-attachments'
import './mobile-native-chat-draft-store'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import './use-mobile-native-chat-drafts'
import './use-mobile-structured-native-chat-send-bridge'
import '../mobile-native-chat-scope-key'
import '../agent-session/use-mobile-structured-agent-session'
import '../agent-session/use-mobile-structured-agent-session-queued.test-fixture'
import '../../structured-agent-send-result.test-fixture'
import { findByHostType } from '../../../test-support/react-test-renderer-host-nodes'

import '../agent-session/mobile-structured-agent-session-host-support'
import '../../../../../src/shared/agent-session/agent-session-runtime-capabilities'
import '../input/use-mobile-structured-agent-options'
import '../input/use-mobile-structured-agent-options.test-fixture'

import { createElement, type ComponentProps } from 'react'

import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../../../test-support/query-client-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer as NativeChatComposer } from './MobileNativeChatComposer'
vi.mock('../../../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('./MobileNativeChatContextUsageRing', () => ({
  useMobileNativeChatContextRing: () => ({ barProps: {}, ring: null })
}))
vi.mock('../../../platform/media-picker', () => ({
  useMediaPicker: () => ({ pickImages: async () => [] })
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

const getNoComposerEditGeneration = () => 0

function MobileNativeChatComposer({
  getComposerEditGeneration = getNoComposerEditGeneration,
  ...props
}: Omit<ComponentProps<typeof NativeChatComposer>, 'getComposerEditGeneration'> & {
  getComposerEditGeneration?: () => number
}): React.JSX.Element {
  return createElement(NativeChatComposer, { ...props, getComposerEditGeneration })
}

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
    ScrollView: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  AtSign: 'AtSign',
  Image: 'Image',
  Paperclip: 'Paperclip',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  CornerDownRight: 'CornerDownRight',
  FileText: 'FileText',
  Goal: 'Goal',
  PencilRuler: 'PencilRuler',
  ListEnd: 'ListEnd',
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

describe('MobileNativeChatComposer on a structured chat', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(async () => {
    act(() => renderer?.unmount())
    renderer = null
    await activateMobileUiLocale('en')
  })

  it('forgets inline picked skill identity after its token is removed and retyped', async () => {
    const scope = 'removed-skill'
    updateMobileNativeChatDraftInputs(scope, () => ({
      images: [],
      files: [],
      skills: [{ name: 'review', path: '/remote/SKILL.md' }]
    }))
    await act(async () => {
      renderer = createWithQueryClient(
        createElement(MobileNativeChatComposer, {
          draftScopeKey: scope,
          value: '$review draft',
          editSession: { cancel: vi.fn(), locked: false, refuseCommand: () => false },
          onChangeText: vi.fn(),
          onSend: async () => false,
          sendSurfaceId: scope,
          getSendCompletionGeneration: getNoComposerEditGeneration
        })
      )
    })
    const input = () => findByHostType(renderer!.root, 'TextInput')
    await act(async () => input().props.onChangeText('draft'))
    await act(async () => input().props.onChangeText('$review draft'))
    expect(readMobileNativeChatDraftInputs(scope).skills).toEqual([])
  })
})
