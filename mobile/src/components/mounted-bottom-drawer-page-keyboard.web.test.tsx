// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The page's module graph: react-native-web's own `Keyboard` (no `metrics`, an inert
// `addListener`) and the web sibling of the keyboard seam, as the page bundler resolves them.
vi.mock('react-native', async () => {
  const React = await import('react')
  const { default: Keyboard }: { default: unknown } =
    // @ts-expect-error TS7016: react-native-web ships no type declarations.
    await import('react-native-web/dist/exports/Keyboard')
  return {
    BackHandler: { addEventListener: () => ({ remove: () => {} }) },
    Keyboard,
    Modal: 'Modal',
    Platform: { OS: 'web', select: (options: { web?: unknown }) => options.web },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
    View: 'View',
    // Subscribed, as react-native-web's is: the shell shortening the WebView is a resize.
    useWindowDimensions: () => {
      const read = () => ({ width: window.innerWidth, height: window.innerHeight })
      const [size, setSize] = React.useState(read)
      React.useEffect(() => {
        const onResize = () => setSize(read())
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])
      return size
    }
  }
})
vi.mock(
  '../platform/keyboard-occlusion',
  async () => await import('../platform/keyboard-occlusion.web')
)
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => {
  const chain: Record<string, unknown> = {}
  for (const method of [
    'activeOffsetY',
    'simultaneousWithExternalGesture',
    'onBegin',
    'onUpdate',
    'onEnd'
  ]) {
    chain[method] = () => chain
  }
  return {
    Gesture: { Pan: () => chain, Native: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView', ScrollView: 'AnimatedScrollView' },
  useSharedValue: (initial: number) => ({ value: initial }),
  useAnimatedStyle: () => ({}),
  useAnimatedScrollHandler: () => () => {},
  withSpring: (to: number) => to,
  withTiming: (to: number) => to,
  runOnJS: (fn: () => void) => fn,
  interpolate: () => 0,
  Extrapolation: { CLAMP: 'clamp' }
}))

import { MountedBottomDrawer } from './mounted-bottom-drawer'

const RESTING_HEIGHT = 900
const IME_HEIGHT = 300

function setWindowHeight(height: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  window.dispatchEvent(new Event('resize'))
}

function renderFillSheet(): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      <MountedBottomDrawer visible fillAvailable onClose={() => {}} onHidden={() => {}}>
        {null}
      </MountedBottomDrawer>
    )
  })
  return renderer
}

function sheetStyle(renderer: ReactTestRenderer): Record<string, unknown> {
  const sheet = renderer.root.find((node) => node.props.testID === 'bottom-drawer-sheet')
  const style: unknown[] = [sheet.props.style].flat(Infinity)
  return Object.assign({}, ...style.filter((entry) => typeof entry === 'object' && entry !== null))
}

describe('a fill-mode sheet on the page', () => {
  afterEach(() => setWindowHeight(RESTING_HEIGHT))

  it('mounts against react-native-web, whose Keyboard has no metrics()', () => {
    setWindowHeight(RESTING_HEIGHT)
    const renderer = renderFillSheet()
    expect(sheetStyle(renderer).marginBottom).toBe(0)
    act(() => renderer.unmount())
  })

  it('does not lift over a keyboard the shell already shortened the WebView for', () => {
    setWindowHeight(RESTING_HEIGHT)
    const renderer = renderFillSheet()
    act(() => setWindowHeight(RESTING_HEIGHT - IME_HEIGHT))
    // The shortened window is the whole avoidance: the sheet's height follows it and nothing lifts.
    expect(sheetStyle(renderer)).toMatchObject({
      marginBottom: 0,
      height: RESTING_HEIGHT - IME_HEIGHT - 24 - 16
    })
    act(() => renderer.unmount())
  })
})
