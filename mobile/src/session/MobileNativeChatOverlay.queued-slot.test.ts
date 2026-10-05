import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  View: 'View'
}))
// Like the real view: the slot's cards are one child among siblings.
vi.mock('./MobileNativeChatView', async () => {
  const React = await import('react')
  return {
    MobileNativeChatView: (props: { queuedSlot?: { cards?: React.ReactNode } }) =>
      React.createElement('View', null, 'list', props.queuedSlot?.cards, 'prompt-card')
  }
})
vi.mock('./MobileNativeChatQueuedMessages', () => ({
  MobileNativeChatQueuedMessages: () => {
    useEffect(() => {
      lifecycle.mounts += 1
      return () => {
        lifecycle.unmounts += 1
      }
    }, [])
    return 'queued'
  }
}))
vi.mock('./MobileNativeChatAsyncQuestions', () => ({
  MobileNativeChatAsyncQuestions: 'AsyncQuestions'
}))

function overlay(blocking: boolean): ReturnType<typeof createElement> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the overlay reads only these controller members; the rest of the controller is unreachable from it.
  const controller = {
    showNativeChat: true,
    nativeChatSession: { messages: [], status: 'ready', asyncQuestions: { state: 'absent' } },
    nativeChatAgent: 'codex',
    nativeChatAgentWorking: false,
    nativeChatStreamLive: false,
    nativeChatStreamScopeKey: 'tab-a',
    chatPending: [],
    chatImagePreviewsByMessageId: {},
    chatComposerText: '',
    setChatComposerText: vi.fn(),
    nativeChatQueued: {
      cards: [{ messageId: 'm1' }],
      send: vi.fn(),
      delete: vi.fn(),
      edit: vi.fn(),
      pause: null,
      resume: vi.fn(),
      sessionKey: 'session-a'
    },
    nativeChatAsyncQuestions: { open: [] },
    ...(blocking ? { nativeChatPermission: { id: 'p' } } : {})
  } as unknown as MobileNativeChatController
  return createElement(MobileNativeChatOverlay, {
    controller,
    onOpenFile: vi.fn(),
    images: {} as never,
    onMicPress: vi.fn(),
    micActive: false,
    dictationMode: 'toggle',
    onMicPressIn: vi.fn(),
    onMicPressOut: vi.fn(),
    inputLockReason: null,
    sendErrorMessage: null,
    onClearSendError: vi.fn(),
    sendSurfaceId: 'tab-a',
    getSendCompletionGeneration: () => 0,
    keyboardInset: 0
  })
}

describe('MobileNativeChatOverlay queued cards', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('keeps the queued cards mounted while a blocking card appears and clears', () => {
    act(() => {
      renderer = create(overlay(false))
    })
    act(() => renderer?.update(overlay(true)))
    act(() => renderer?.update(overlay(false)))
    // Remounting would drop their busy state and same-frame double-tap guard.
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 })
  })
})
