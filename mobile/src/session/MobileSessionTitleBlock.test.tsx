import { Animated, View } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { assert, expect, it, vi } from 'vitest'
import { MobileSessionTitleBlock } from './MobileSessionTitleBlock'
import { useSessionTitleCard } from './use-session-title-card'
import { AnchoredDetailCard } from '../components/AnchoredDetailCard'

const overlay = vi.hoisted(
  (): {
    width: number
    height: number
    back: (() => boolean) | null
    motions: Array<() => () => void>
    measure: (() => void) | null
    claims: number
  } => ({ width: 667, height: 375, back: null, motions: [], measure: null, claims: 0 })
)
vi.mock('../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native', () => {
  class Value {
    value = 0
    cancel = () => {}
    interpolate() {
      return this
    }
    stopAnimation(read?: (value: number) => void) {
      this.cancel()
      read?.(this.value)
    }
  }
  return {
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    BackHandler: {
      addEventListener: (_event: string, claim: () => boolean) => {
        overlay.back = claim
        overlay.claims += 1
        return {
          remove: () => {
            overlay.back = null
          }
        }
      }
    },
    Platform: { OS: 'web', select: (choices: { ios?: string }) => choices.ios },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    useWindowDimensions: () => ({ width: overlay.width, height: overlay.height }),
    Easing: { out: () => () => 0, cubic: () => 0 },
    Animated: {
      View: 'AnimatedView',
      Value,
      timing: (value: Value, config: { toValue: number }) => ({
        start: (done: (result: { finished: boolean }) => void) => {
          let result: typeof done | undefined = done
          const take = (finished: boolean) => {
            const pending = result
            result = undefined
            return () => pending?.({ finished })
          }
          value.cancel = () => take(false)()
          overlay.motions.push(() => {
            if (!result) {
              return () => {}
            }
            value.value = config.toValue
            return take(true)
          })
        }
      })
    }
  }
})
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => false }))

function Fixture() {
  const details = useSessionTitleCard(true, false)
  return (
    <View ref={details.barRef}>
      <MobileSessionTitleBlock
        title="workspace"
        connState="connected"
        details={details}
        meta=""
        showConnectionRetry={false}
        onRetry={() => {}}
      />
      <View ref={details.layerRef} testID="layer" onLayout={details.onLayout}>
        {details.visual ? (
          <AnchoredDetailCard
            {...details}
            {...details.visual}
            onDismiss={details.dismiss}
            title="workspace"
          />
        ) : null}
      </View>
    </View>
  )
}

it('preserves title identity and current request across queued results and Back', () => {
  let titleWidth = 40
  const mounted: { renderer?: ReactTestRenderer } = {}
  act(() => {
    mounted.renderer = create(<Fixture />, {
      createNodeMock: (node) => ({
        measureInWindow: (done: (x: number, y: number, w: number, h: number) => void) => {
          if (node.props !== null && typeof node.props === 'object' && 'testID' in node.props) {
            overlay.measure = () => done(20, 10, 627, 365)
          } else {
            done(80, 20, titleWidth, 45)
          }
        }
      })
    })
  })
  const renderer = mounted.renderer
  assert(renderer)
  const root = renderer.root
  const opener = root.findByProps({ accessibilityRole: 'button' })
  const title = opener.findByProps({ children: 'workspace' })
  expect(title.props.onPress).toBe(opener.props.onPress)
  const card = () => root.findByType(AnchoredDetailCard)
  const tap = () => act(() => title.props.onPress())
  const measure = () => act(() => overlay.measure?.())
  const close = () => act(() => root.findAllByProps({ accessible: false })[0]?.props.onPress())
  const finish = () => act(() => overlay.motions.at(-1)?.()())
  const check = (expanded: boolean, present: boolean) => {
    expect(opener.props['aria-expanded']).toBe(expanded)
    expect(root.findAllByType(AnchoredDetailCard)).toHaveLength(Number(present))
    expect(overlay.back !== null).toBe(present)
  }
  const layout = (width: number, height: number) =>
    root
      .findByProps({ testID: 'layer' })
      .props.onLayout({ nativeEvent: { layout: { width, height } } })
  act(() => layout(627, 365))
  check(false, false)
  act(() => {
    opener.props.onPress()
    opener.props.onPress()
  })
  expect(overlay.measure).toBeNull()
  tap()
  check(true, false)
  const dismissed = overlay.measure
  act(() => opener.props.onLayout())
  act(() => dismissed?.())
  check(false, false)
  tap()
  measure()
  const originalCard = root.findByType(Animated.View)
  expect(originalCard.props.style[1]).toMatchObject({ left: 60, top: 55, width: 256 })
  finish()
  close()
  check(false, true)
  const oldMotion = card().props.motion
  const settle = card().props.onSettled
  const queued = overlay.motions.at(-1)?.()
  tap()
  check(true, true)
  act(() => {
    overlay.measure?.()
    queued?.()
  })
  check(true, true)
  expect(root.findByType(Animated.View)).toBe(originalCard)
  finish()
  close()
  act(() => settle(oldMotion))
  check(false, true)
  const motions = overlay.motions.length
  close()
  expect(overlay.motions).toHaveLength(motions)
  expect(overlay.claims).toBe(1)
  tap()
  finish()
  check(true, false)
  measure()
  close()
  check(false, false)
  expect(overlay.motions).toHaveLength(motions + 1)
  tap()
  measure()
  finish()
  overlay.height = 300
  act(() => layout(627, 290))
  expect(root.findByType(Animated.View).props.style[1].maxHeight).toBe(227)
  titleWidth = 160
  act(() => opener.props.onLayout())
  expect(root.findAllByProps({ accessible: false })[3]?.props.style.left).toBe(220)
  tap()
  measure()
  finish()
  overlay.width = 375
  act(() => renderer.update(<Fixture />))
  act(() => expect(overlay.back?.()).toBe(true))
  finish()
  check(false, false)
  expect(root.findByProps({ accessibilityRole: 'button' })).toBe(opener)
  expect(opener.findByProps({ children: 'workspace' })).toBe(title)
  act(() => renderer.unmount())
})
