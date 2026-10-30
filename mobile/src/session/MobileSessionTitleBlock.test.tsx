import { useMemo, useRef } from 'react'
import { Animated, Pressable, View } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { assert, expect, it, vi } from 'vitest'
import { MobileSessionHeader } from './MobileSessionHeader'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useDetailCardSource, type DetailCardSource } from '../components/use-anchored-detail-card'
import { useSessionTitleCard } from './use-session-title-card'
import { AnchoredDetailCard } from '../components/AnchoredDetailCard'
import { SideRailProvider } from '../layout/side-rail'
import { useSessionSideRail } from './session-side-rail'

const overlay = vi.hoisted(
  (): {
    width: number
    height: number
    back: (() => boolean) | null
    motions: (() => () => void)[]
    measure: (() => void) | null
  } => ({ width: 667, height: 375, back: null, motions: [], measure: null })
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
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon' }))
vi.mock('../layout/host-sidebar-reveal', () => ({ useHostSidebarReveal: () => null }))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false })
}))
vi.mock('./MobileSessionTabStrip', () => ({ MobileSessionTabStrip: () => null }))
vi.mock('./MobileSessionAccessoryKeys', () => ({ MobileSessionAccessoryKeys: () => null }))
vi.mock('./MobileSessionCommandDock', () => ({ sessionCommandDockShown: () => false }))
const leave = vi.fn()
const headerFields: Partial<MobileSessionController> = {
  worktreeName: 'workspace',
  connState: 'connected',
  presentedConnState: 'connected',
  visibleTabs: [],
  requestLeaveSession: leave,
  isFloatingWorkspaceRoute: true,
  terminalSummary: ''
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This header fixture supplies every rendered field; no tabs or panel actions are exercised.
const header = headerFields as MobileSessionController

function Fixture() {
  const details = useSessionTitleCard(true, false, [{ id: 'back' }])
  const tabRef = useRef<View>(null)
  const source = useMemo<DetailCardSource>(
    () => ({
      key: 'tab:back',
      anchorRef: tabRef,
      openerRef: tabRef,
      barRef: details.barRef,
      geometry: 'refresh'
    }),
    [details.barRef]
  )
  useDetailCardSource(details, source)
  const rail = useSessionSideRail(header, details)
  return (
    <View>
      <Pressable
        ref={tabRef}
        accessibilityLabel="Tab details"
        onPress={() => details.toggleSource(source)}
      />
      <MobileSessionHeader controller={header} details={details} backInRail={rail.backInRail} />
      <View ref={details.layerRef} testID="layer" onLayout={details.onLayout}>
        {details.visual ? (
          <AnchoredDetailCard {...details} {...details.visual} obscured={false} title="workspace" />
        ) : null}
      </View>
    </View>
  )
}

function Screen({ rail = false }: { rail?: boolean }) {
  return (
    <SideRailProvider edge={rail ? 'right' : null} width={84} bottom={0}>
      <Fixture />
    </SideRailProvider>
  )
}

it('preserves title identity and current request across queued results and Back', () => {
  const mounted: { renderer?: ReactTestRenderer } = {}
  act(() => {
    mounted.renderer = create(<Screen />, {
      createNodeMock: (node) => ({
        measureInWindow: (done: (x: number, y: number, w: number, h: number) => void) => {
          if (node.props !== null && typeof node.props === 'object' && 'testID' in node.props) {
            overlay.measure = () => done(20, 10, 627, 365)
          } else {
            done(80, 20, 40, 45)
          }
        }
      })
    })
  })
  const renderer = mounted.renderer
  assert(renderer)
  const root = renderer.root
  const opener = root.findByProps({ 'aria-expanded': false })
  const title = opener.findByProps({ children: 'workspace' })
  const card = () => root.findByType(AnchoredDetailCard)
  const tap = () => act(() => title.props.onPress())
  const measure = () => act(() => overlay.measure?.())
  const back = root.findByProps({ hitSlop: 4 })
  const close = () => act(() => back.props.onPress())
  const finish = () => act(() => overlay.motions.at(-1)?.()())
  const check = (expanded: boolean, present: boolean) => {
    expect(opener.props['aria-expanded']).toBe(expanded)
    expect(root.findAllByType(AnchoredDetailCard)).toHaveLength(Number(present))
    expect(overlay.back !== null).toBe(expanded)
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
  close()
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
  expect(leave).toHaveBeenCalledTimes(1)
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
  act(() => opener.props.onLayout())
  check(false, true)
  tap()
  measure()
  finish()
  overlay.width = 375
  act(() => expect(overlay.back?.()).toBe(true))
  act(() => renderer.update(<Screen />))
  finish()
  check(false, false)
  expect(root.findByProps({ 'aria-expanded': false })).toBe(opener)
  expect(opener.findByProps({ children: 'workspace' })).toBe(title)
  act(() => renderer.update(<Screen rail />))
  expect(root.findAllByProps({ hitSlop: 4 })).toHaveLength(0)
  const railBack = root.findByProps({
    accessibilityRole: 'button',
    accessibilityLabel: 'Back to worktrees'
  })
  tap()
  check(true, false)
  const railMeasurement = overlay.measure
  act(() => railBack.props.onPress())
  act(() => railMeasurement?.())
  check(false, false)
  expect(leave).toHaveBeenCalledTimes(1)
  tap()
  measure()
  finish()
  act(() => railBack.props.onPress())
  check(false, true)
  expect(leave).toHaveBeenCalledTimes(1)
  act(() => railBack.props.onPress())
  expect(leave).toHaveBeenCalledTimes(2)
  expect(root.findByProps({ 'aria-expanded': false })).toBe(opener)
  act(() => renderer.unmount())
})

it.each([false, true])(
  'closes pending and measured tab details before leaving, rail=%s',
  (rail) => {
    overlay.width = 667
    overlay.height = 375
    overlay.measure = null
    leave.mockClear()
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(<Screen rail={rail} />, {
        createNodeMock: (node) => ({
          measureInWindow: (done: (x: number, y: number, w: number, h: number) => void) => {
            const props = node.props
            if (
              props &&
              typeof props === 'object' &&
              'testID' in props &&
              props.testID === 'layer'
            ) {
              overlay.measure = () => done(0, 0, 667, 375)
            } else {
              done(80, 20, 40, 45)
            }
          }
        })
      })
    })
    assert(renderer)
    const mounted = renderer
    const root = mounted.root
    const tap = () =>
      act(() => root.findByProps({ accessibilityLabel: 'Tab details' }).props.onPress())
    const back = () =>
      act(() =>
        (rail
          ? root.findByProps({
              accessibilityRole: 'button',
              accessibilityLabel: 'Back to worktrees'
            })
          : root.findByProps({ hitSlop: 4 })
        ).props.onPress()
      )
    tap()
    const readMeasurement = (): (() => void) | null => overlay.measure
    const stale = readMeasurement()
    back()
    act(() => stale?.())
    expect(root.findAllByType(AnchoredDetailCard)).toHaveLength(0)
    expect(leave).not.toHaveBeenCalled()
    tap()
    act(() => overlay.measure?.())
    expect(root.findByType(AnchoredDetailCard).props.active).toBe(true)
    act(() => overlay.motions.at(-1)?.()())
    back()
    expect(root.findByType(AnchoredDetailCard).props.active).toBe(false)
    expect(leave).not.toHaveBeenCalled()
    back()
    expect(leave).toHaveBeenCalledTimes(1)
    act(() => mounted.unmount())
  }
)
