import { createElement, useState, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'
import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'

vi.mock('react-native', async () => ({
  ...(await import('../../test-support/react-native-motion-stub')).reactNativeMotionStub(),
  Platform: { OS: 'web' },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => ({
  Gesture: {},
  GestureDetector: 'GestureDetector'
}))
vi.mock('./composer/use-mobile-native-chat-composer-tray', () => ({
  useMobileNativeChatComposerTray: () => null
}))
vi.mock('./transcript/MobileNativeChatRowOverlaysHost', () => ({
  MobileNativeChatRowOverlaysHost: ({ children }: { children: ReactNode }) => children
}))
// Stands in for the chat list: its state lives exactly as long as the mounted view.
vi.mock('./MobileNativeChatView', () => ({
  MobileNativeChatView: ({ messages }: { messages: NativeChatMessage[] }) => {
    const [mountId] = useState(() => Symbol('chat view'))
    return createElement('ChatView', { mountId, ids: messages.map((message) => message.id) })
  }
}))

const message = (id: string): NativeChatMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text: `reply ${id}` }]
})

function overlay(showNativeChat: boolean, messages: NativeChatMessage[]) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the overlay reads only these controller members here.
  const controller = {
    showNativeChat,
    nativeChatSession: { messages, status: 'ready' },
    nativeChatAgent: 'claude',
    nativeChatStructured: false,
    nativeChatTurnActive: false,
    nativeChatItemSource: null,
    nativeChatVisualSource: null,
    chatPending: [],
    nativeChatQueued: { cards: [], pause: null, sessionKey: 'session' }
  } as unknown as MobileNativeChatController
  return createElement(MobileNativeChatOverlay, {
    controller,
    worktreePath: null,
    connState: 'connected',
    onOpenFile: () => {},
    images: {
      attachments: [],
      isAttaching: false,
      attachImage: async () => {},
      removeAttachment: () => {},
      sendNativeChat: () => {}
    },
    onMicPress: undefined,
    micActive: false,
    micStarting: false,
    micProcessing: false,
    dictationMode: undefined,
    onMicPressIn: () => {},
    onMicPressOut: () => {},
    inputLockReason: null,
    sendErrorMessage: null,
    onClearSendError: () => {},
    sendSurfaceId: 'host\0worktree\0tab',
    sessionId: 'session',
    getSendCompletionGeneration: () => 0,
    keyboardInset: 0,
    hostName: null,
    onRunInTerminal: () => {}
  })
}

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

it('keeps the chat view mounted and hidden while its terminal shows', () => {
  const rows = [message('a'), message('b')]
  act(() => {
    renderer = create(overlay(true, rows))
  })
  const shown = renderer!.root.findByType('ChatView' as never).props
  expect(shown.ids).toEqual(['a', 'b'])

  // The hidden lane reads as an empty chat; the overlay draws nothing and keeps the last chat.
  act(() => renderer!.update(overlay(false, [])))
  expect(renderer!.toJSON()).toBeNull()
  expect(renderer!.root.findByType('ChatView' as never).props.ids).toEqual(['a', 'b'])

  act(() => renderer!.update(overlay(true, [...rows, message('c')])))
  const back = renderer!.root.findByType('ChatView' as never).props
  expect(back.mountId).toBe(shown.mountId)
  expect(back.ids).toEqual(['a', 'b', 'c'])
})
