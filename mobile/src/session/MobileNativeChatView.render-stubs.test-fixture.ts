import { vi } from 'vitest'

const scrollToEnd = vi.hoisted(() => vi.fn())
const scrollToOffset = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ OS: 'ios' }))
const pageScroller = vi.hoisted(() => ({
  scrollTop: 0,
  scrollHeight: 0,
  clientHeight: 500,
  getInnerViewNode: () => ({}),
  getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
  getAttribute: () => null,
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {}
}))

export async function reactNativeStub() {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      Value: class {
        constructor(readonly value: number) {}
      },
      timing: () => ({ start: () => {}, stop: () => {} }),
      View: 'Animated.View'
    },
    FlatList: React.forwardRef((props, ref) => {
      const handle = { scrollToEnd, scrollToOffset, getScrollableNode: () => pageScroller }
      React.useImperativeHandle(ref, () => handle, [])
      return React.createElement('FlatList', props)
    }),
    Platform: platform,
    Pressable: 'Pressable',
    ScrollView: React.forwardRef((props, ref) => {
      const handle = {
        scrollTo: ({ y, animated }: { y: number; animated: boolean }) =>
          scrollToOffset({ animated, offset: y }),
        scrollToEnd,
        getScrollableNode: () => pageScroller,
        getInnerViewNode: () => pageScroller.getInnerViewNode()
      }
      React.useImperativeHandle(ref, () => handle, [])
      return React.createElement('ScrollView', props)
    }),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
}

export function gestureHandlerStub() {
  const chain = {
    runOnJS: () => chain,
    onStart: () => chain,
    onUpdate: () => chain
  }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
}

export async function composerStub() {
  const React = await import('react')
  const { MobileNativeChatStopButton } =
    await import('./native-chat/input/MobileNativeChatStopButton')
  const { useMobileNativeChatDraft } =
    await import('./native-chat/composer/mobile-native-chat-draft-store')
  return {
    MobileNativeChatDraftComposer: ({
      draftKey,
      ...props
    }: {
      draftKey: string | null
      onSend: (text: string) => Promise<boolean>
      disabled?: boolean
      placeholder?: string
      stop?: { onStop?: () => void; held: boolean } | null
    }) =>
      React.createElement(
        'Composer',
        {
          ...props,
          value: useMobileNativeChatDraft(draftKey),
          accessibilityLabel: 'Send message',
          onPress: () => props.onSend('hi')
        },
        props.stop ? React.createElement(MobileNativeChatStopButton, props.stop) : null
      )
  }
}

export { scrollToEnd, scrollToOffset, platform, pageScroller }
