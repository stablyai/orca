import { createElement, type ComponentProps, type ReactNode } from 'react'
import { Pressable, TextInput } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { publishMobileChatDraftStorage } from './mobile-native-chat-draft-storage'
import { resetMobileNativeChatDraftStoreForTests } from './mobile-native-chat-draft-store'
import { MobileNativeChatComposer as NativeChatComposer } from './MobileNativeChatComposer'

const getNoComposerEditGeneration = () => 0

function MobileNativeChatComposer({
  getComposerEditGeneration = getNoComposerEditGeneration,
  ...props
}: Omit<ComponentProps<typeof NativeChatComposer>, 'getComposerEditGeneration'> & {
  getComposerEditGeneration?: () => number
}): React.JSX.Element {
  return createElement(NativeChatComposer, { ...props, getComposerEditGeneration })
}

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Keyboard: { dismiss: vi.fn() },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
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

it.each([false, true])(
  'holds actual first-paint authoring until the read settles (failure=%s)',
  async (fails) => {
    let resolveRead = (_value: string | null) => {}
    let rejectRead = (_error: Error) => {}
    const read = new Promise<string | null>((resolve, reject) => {
      resolveRead = resolve
      rejectRead = reject
    })
    const write = vi.fn(async () => {})
    const onSend = vi.fn(async () => true)
    const onAttachImage = vi.fn()
    const onMicPress = vi.fn()
    const onStop = vi.fn()
    const messages: NativeChatMessage[] = []
    const frames: boolean[] = []
    let renderer: ReactTestRenderer | undefined
    let reconnecting = false
    function Harness() {
      const draft = useMobileNativeChatDrafts({
        hostId: 'first',
        worktreeId: 'workspace',
        tabId: 'tab',
        sessionId: 'session',
        messages,
        transcriptSettled: true
      })
      frames.push(draft.draftAuthoringReady)
      return createElement(MobileNativeChatComposer, {
        value: draft.composerText,
        authoringReady: draft.draftAuthoringReady,
        onChangeText: draft.setComposerText,
        onSend,
        onAttachImage,
        onMicPress,
        disabled: reconnecting,
        stop: { onStop, held: false },
        sendSurfaceId: 'first',
        getSendCompletionGeneration: () => 0
      })
    }
    publishMobileChatDraftStorage({ read: () => read, write, removeWorkspace: async () => {} })
    try {
      await act(async () => {
        renderer = create(createElement(Harness))
      })
      const field = () => renderer!.root.findByType(TextInput)
      const button = (label: string) =>
        renderer!.root.find(
          (node) => node.type === Pressable && node.props.accessibilityLabel === label
        )
      expect(frames[0]).toBe(false)
      expect(field().props.editable).toBe(false)
      expect(button('Attach image').props.disabled).toBe(true)
      expect(button('Dictate').props.disabled).toBe(true)
      await act(async () => {
        field().props.onChangeText('must not replace saved draft')
      })
      expect(field().props.value).toBe('')
      await act(async () => button('Stop the agent').props.onPress())
      expect(onStop).toHaveBeenCalledOnce()
      await act(async () => {
        if (fails) {
          rejectRead(new Error('unreadable'))
        } else {
          resolveRead(
            JSON.stringify({
              text: 'saved $review',
              images: [],
              skills: [{ name: 'review', path: '/saved/SKILL.md' }]
            })
          )
        }
      })
      expect(field().props.editable).toBe(true)
      expect(field().props.value).toBe(fails ? '' : 'saved $review')
      await act(async () => {
        field().props.onChangeText('next draft')
      })
      expect(field().props.value).toBe('next draft')
      reconnecting = true
      await act(async () => renderer!.update(createElement(Harness)))
      expect(field().props.editable).toBe(true)
      await act(async () => {
        field().props.onChangeText('still editable')
      })
      expect(field().props.value).toBe('still editable')
      if (fails) {
        expect(write).not.toHaveBeenCalled()
      }
    } finally {
      act(() => renderer?.unmount())
      resetMobileNativeChatDraftStoreForTests()
      publishMobileChatDraftStorage(null)
    }
  }
)
