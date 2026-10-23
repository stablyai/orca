import { vi } from 'vitest'

const scrollToEnd = vi.hoisted(() => vi.fn())
const scrollToOffset = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ OS: 'ios' }))
// The page list's live DOM geometry.
const pageScroller = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event?: unknown) => void>>()
  return {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 500,
    clientWidth: 320,
    style: { overflowAnchor: '' },
    getInnerViewNode: () => ({}),
    getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    addEventListener: (type: string, listener: (event?: unknown) => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
    },
    removeEventListener: (type: string, listener: (event?: unknown) => void) => {
      listeners.get(type)?.delete(listener)
    },
    // The browser's scroll event at the scroller's current position.
    scroll: () => listeners.get('scroll')?.forEach((listener) => listener()),
    // The reader's hand on the scroller, e.g. a wheel turn.
    input: (type: string) => listeners.get(type)?.forEach((listener) => listener())
  }
})

export async function reactNativeStub() {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      const handle = { scrollToEnd, scrollToOffset, getScrollableNode: () => pageScroller }
      React.useImperativeHandle(ref, () => handle, [])
      return React.createElement('FlatList', props)
    }),
    Platform: platform,
    Pressable: 'Pressable',
    // The page's list scrolls through it.
    ScrollView: React.forwardRef((props, ref) => {
      const handle = {
        scrollTo: ({ y, animated }: { y: number; animated: boolean }) =>
          scrollToOffset({ animated, offset: y }),
        scrollToEnd,
        getScrollableNode: () => pageScroller
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
  const { MobileNativeChatStopButton } = await import('./MobileNativeChatStopButton')
  return {
    MobileNativeChatComposer: (props: {
      onSend: (text: string) => Promise<boolean>
      disabled?: boolean
      placeholder?: string
      stop?: { onStop?: () => void; held: boolean } | null
    }) =>
      React.createElement(
        'Composer',
        { ...props, accessibilityLabel: 'Send message', onPress: () => props.onSend('hi') },
        // The real composer draws Stop in Send's slot while its draft is empty, as here.
        props.stop ? React.createElement(MobileNativeChatStopButton, props.stop) : null
      )
  }
}

export { scrollToEnd, scrollToOffset, platform, pageScroller }
