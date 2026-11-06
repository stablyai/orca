import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { View } from 'react-native'
import { mountFixture } from '../../../test-support/rpc-recording/recorder-fixture-shape'
import { useMobileNativeChatContextRing } from './MobileNativeChatContextUsageRing'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Animated: { View: 'View' },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  useWindowDimensions: () => ({ width: 400, height: 800 })
}))
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle' }))
vi.mock('../../../components/use-detail-card-motion', () => ({
  useDetailCardMotion: () => ({ opacity: 1 })
}))
vi.mock('../../../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => false }))
vi.mock('../../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'light' }))
vi.mock('../../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../../../platform/keyboard-occlusion', () => ({ useKeyboardOcclusion: () => 0 }))
vi.mock('../../../platform/keyboard-persisting-taps', () => ({
  useKeyboardPersistingTaps: () => () => {}
}))
vi.mock('../../../components/use-detail-card-scope', () => ({ useDetailCardScope: () => {} }))
vi.mock('../../../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../../../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 })
}))

function Composer() {
  const { barProps, ring } = useMobileNativeChatContextRing(
    {
      usedTokens: 25000,
      windowTokens: 100000,
      percentage: 25,
      estimated: false,
      rows: []
    },
    false
  )
  return createElement('View', { ...barProps, testID: 'composer' }, ring)
}

it('opens context details above the composer in an inset card layer', () => {
  let renderer!: ReactTestRenderer
  let composerMeasured: Parameters<View['measureInWindow']>[0] | undefined
  let layerMeasured: Parameters<View['measureInWindow']>[0] | undefined
  act(() => {
    renderer = create(createElement(Composer), {
      createNodeMock: ({ props }) =>
        mountFixture<View>({
          measureInWindow: (done) => {
            if (
              typeof props === 'object' &&
              props !== null &&
              'testID' in props &&
              props.testID === 'composer'
            ) {
              composerMeasured = done
            } else {
              layerMeasured = done
            }
          }
        })
    })
  })
  try {
    const layer = renderer.root.findByProps({ pointerEvents: 'box-none' })
    act(() => layer.props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } }))
    act(() => renderer.root.findByProps({ testID: 'native-chat-context-usage' }).props.onPress())
    act(() => {
      if (!composerMeasured || !layerMeasured) {
        throw new Error('The card must request both measurements before either native reply')
      }
      composerMeasured(20, 600, 360, 48)
      layerMeasured(10, 20, 400, 800)
    })
    const dialog = renderer.root.findByProps({ role: 'dialog' })
    const placement = Object.assign({}, ...dialog.props.style)
    expect({ left: placement.left, bottom: placement.bottom }).toEqual({ left: 114, bottom: 228 })
  } finally {
    act(() => renderer.unmount())
  }
})
