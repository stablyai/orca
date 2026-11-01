import { vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Platform: { OS: 'ios' },
    Keyboard: { dismiss: vi.fn() },
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: vi.fn(), scrollToOffset: vi.fn() }), [])
      return React.createElement('FlatList', props)
    }),
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => {
  type GestureChain = {
    runOnJS: () => GestureChain
    onStart: () => GestureChain
    onUpdate: () => GestureChain
  }
  const chain: GestureChain = { runOnJS: () => chain, onStart: () => chain, onUpdate: () => chain }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('lucide-react-native', () =>
  Object.fromEntries(
    [
      'ArrowDown',
      'ArrowUp',
      'ListEnd',
      'CornerDownRight',
      'ChevronDown',
      'ChevronUp',
      'ChevronsDownUp',
      'ChevronsUpDown',
      'ShieldQuestion',
      'ImagePlus',
      'Plus',
      'Mic',
      'Square',
      'X',
      'Check',
      'CircleHelp'
    ].map((x) => [x, x])
  )
)
vi.mock('../native-chat/transcript/MobileNativeChatMessage', () => ({
  MobileNativeChatMessage: 'ChatMessage'
}))
vi.mock('../native-chat/transcript/MobileNativeChatRowOverlaysHost', () => ({
  MobileNativeChatRowOverlaysHost: 'View'
}))
vi.mock('../native-chat/visual/MobileNativeChatVisual', () => ({
  useMobileNativeChatVisualRenderer: () => null
}))
vi.mock('../../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => null }))
vi.mock('../native-chat/transcript/MobileNativeChatLiveLine', () => ({
  MobileNativeChatLiveLine: 'LiveStatus'
}))
vi.mock('../native-chat/input/MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('../native-chat/input/MobileNativeChatSessionOptionPickers', () => ({
  MobileNativeChatSessionOptionPickers: 'SessionOptions'
}))
vi.mock('../native-chat/composer/MobileNativeChatComposerMenu', () => ({
  MobileNativeChatComposerMenu: 'Suggestions'
}))
vi.mock('../../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../../components/MobileMarkdown', () => ({ MobileMarkdown: 'Markdown' }))
