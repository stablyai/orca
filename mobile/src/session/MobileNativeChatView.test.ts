import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatView } from './MobileNativeChatView'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 })
}))

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: 'GestureDetector',
  GestureHandlerRootView: 'GestureHandlerRootView'
}))

vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))

vi.mock('./mobile-native-chat-view-styles', () => ({ styles: {} }))
vi.mock('./mobile-native-chat-render-data', () => ({
  buildMobileNativeChatTransientData: () => ({ data: [] }),
  foldMobileNativeChatMessages: () => [],
  mobileNativeChatEmptyState: () => null
}))
vi.mock('./use-mobile-native-chat-ask-dismiss', () => ({
  useMobileNativeChatAskDismiss: () => ({
    askKey: null,
    showAsk: false,
    dismissAsk: vi.fn()
  })
}))
vi.mock('./use-mobile-native-chat-pinch-gesture', () => ({
  useMobileNativeChatPinchGesture: () => ({ fontScale: 1, pinchGesture: {} })
}))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'MobileAgentWorkingIndicator'
}))
vi.mock('./MobileNativeChatComposer', () => ({
  MobileNativeChatComposer: 'MobileNativeChatComposer'
}))
vi.mock('./MobileNativeChatMessage', () => ({
  MobileNativeChatMessage: 'MobileNativeChatMessage'
}))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'MobileNativeChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({
  MobileNativeChatPermission: 'MobileNativeChatPermission'
}))
vi.mock('./MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: 'MobileNativeChatQuestion'
}))

describe('MobileNativeChatView', () => {
  let renderer: ReactTestRenderer | null = null
  let previousActEnvironment: boolean | undefined

  beforeEach(() => {
    previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  })

  function composerProps(): { sendDisabled: boolean; placeholder: string } {
    return renderer!.root.findByType('MobileNativeChatComposer').props as {
      sendDisabled: boolean
      placeholder: string
    }
  }

  function suppressRendererWarning(): () => void {
    const original = console.error
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    return () => error.mockRestore()
  }

  it('disables sending immediately while delaying only the waiting copy', async () => {
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(MobileNativeChatView, {
            messages: [],
            status: 'ready',
            onSend: vi.fn().mockResolvedValue(true),
            pending: [],
            composerText: 'hello',
            onComposerTextChange: vi.fn(),
            inputLockReason: 'waiting'
          })
        )
      })

      expect(composerProps()).toMatchObject({
        sendDisabled: true,
        placeholder: 'Message, @files, /commands'
      })

      await act(async () => vi.advanceTimersByTime(600))
      expect(composerProps()).toMatchObject({
        sendDisabled: true,
        placeholder: 'Waiting for terminal…'
      })

      await act(async () => {
        renderer?.update(
          createElement(MobileNativeChatView, {
            messages: [],
            status: 'ready',
            onSend: vi.fn().mockResolvedValue(true),
            pending: [],
            composerText: 'hello',
            onComposerTextChange: vi.fn(),
            inputLockReason: null
          })
        )
      })
      expect(composerProps()).toMatchObject({
        sendDisabled: false,
        placeholder: 'Message, @files, /commands'
      })
    } finally {
      restore()
    }
  })

  it('cancels waiting copy when the lease unlocks before the delay', async () => {
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(MobileNativeChatView, {
            messages: [],
            status: 'ready',
            onSend: vi.fn().mockResolvedValue(true),
            pending: [],
            composerText: 'hello',
            onComposerTextChange: vi.fn(),
            inputLockReason: 'waiting'
          })
        )
      })
      await act(async () => vi.advanceTimersByTime(300))
      await act(async () => {
        renderer?.update(
          createElement(MobileNativeChatView, {
            messages: [],
            status: 'ready',
            onSend: vi.fn().mockResolvedValue(true),
            pending: [],
            composerText: 'hello',
            onComposerTextChange: vi.fn(),
            inputLockReason: null
          })
        )
      })
      await act(async () => vi.advanceTimersByTime(600))

      expect(composerProps()).toMatchObject({
        sendDisabled: false,
        placeholder: 'Message, @files, /commands'
      })
    } finally {
      restore()
    }
  })

  it('updates an already-visible lock reason without another copy delay', async () => {
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(MobileNativeChatView, {
            messages: [],
            status: 'ready',
            onSend: vi.fn().mockResolvedValue(true),
            pending: [],
            composerText: 'hello',
            onComposerTextChange: vi.fn(),
            inputLockReason: 'waiting'
          })
        )
      })
      await act(async () => vi.advanceTimersByTime(600))
      await act(async () => {
        renderer?.update(
          createElement(MobileNativeChatView, {
            messages: [],
            status: 'ready',
            onSend: vi.fn().mockResolvedValue(true),
            pending: [],
            composerText: 'hello',
            onComposerTextChange: vi.fn(),
            inputLockReason: 'disconnected'
          })
        )
      })

      expect(composerProps()).toMatchObject({
        sendDisabled: true,
        placeholder: 'Reconnecting…'
      })
    } finally {
      restore()
    }
  })
})
