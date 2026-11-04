import { createContext, useMemo, useRef } from 'react'
import { Animated, Pressable, View } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { assert, expect, it, vi } from 'vitest'
import { MobileSessionHeader } from './MobileSessionHeader'
import { MobileSessionSurface } from './MobileSessionSurface'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useDetailCardSource, type DetailCardSource } from '../components/use-anchored-detail-card'
import { useSessionTitleCard } from './use-session-title-card'
import { AnchoredDetailCard } from '../components/AnchoredDetailCard'

const overlay = vi.hoisted(
  (): {
    width: number
    height: number
    rail: boolean
    back: (() => boolean) | null
    motions: (() => () => void)[]
    measure: (() => void) | null
  } => ({ width: 667, height: 375, rail: false, back: null, motions: [], measure: null })
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
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
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
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Folder: 'Icon',
  GitBranch: 'Icon',
  MoreHorizontal: 'Icon',
  PanelLeftOpen: 'Icon',
  Columns2: 'Icon',
  Plus: 'Icon',
  SquareChevronRight: 'Icon'
}))
vi.mock('../layout/host-sidebar-reveal', () => ({ useHostSidebarReveal: () => null }))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false, width: overlay.width })
}))
vi.mock('./MobileSessionTabStrip', () => ({ MobileSessionTabStrip: () => null }))
vi.mock('../layout/use-top-chrome-space', () => ({ useTopChromeSpace: () => ({}) }))
vi.mock('../layout/use-shell-side-rail', () => ({ useShellSideRail: () => overlay.rail }))
vi.mock('./MobileSessionHeaderMoreMenu', () => ({
  MobileSessionHeaderMoreMenu: () => null
}))
vi.mock('./MobileSessionContentRow', () => ({ MobileSessionContentRow: () => null }))
vi.mock('./MobileSessionSheets', () => ({ MobileSessionSheets: () => null }))
vi.mock('./MobileSessionTabCardFooter', () => ({ MobileSessionTabCardFooter: () => null }))
vi.mock('./MobileWorkerAutoCloseStrip', () => ({ MobileWorkerAutoCloseStrip: () => null }))
vi.mock('../transport/use-workspace-client', () => ({
  WorkspaceServerContext: createContext(null)
}))
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
  return (
    <View>
      <Pressable
        ref={tabRef}
        accessibilityLabel="Tab details"
        onPress={() => details.toggleSource(source)}
      />
      <MobileSessionHeader controller={header} details={details} />
      <View ref={details.layerRef} testID="layer" onLayout={details.onLayout}>
        {details.visual ? (
          <AnchoredDetailCard {...details} {...details.visual} obscured={false} title="workspace" />
        ) : null}
      </View>
    </View>
  )
}

function Screen({ rail = false }: { rail?: boolean }) {
  overlay.rail = rail
  return <Fixture />
}

// The bar's title block is an Animated.View too; the details card is the one placed by style.
function detailsCard(root: ReactTestRenderer['root']) {
  return root.find(
    (node) =>
      node.type === Animated.View && Array.isArray(node.props.style) && !!node.props.style[1]
  )
}

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
        root
          .findByProps({ accessibilityRole: 'button', accessibilityLabel: 'Back to worktrees' })
          .props.onPress()
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
it('releases an open card and pending measurements when the connected Duo header removes its title', () => {
  overlay.rail = true
  const pending: (() => void)[] = []
  const screen = (retry: boolean) => (
    <MobileSessionSurface
      controller={mountFixture<MobileSessionController>({
        ...headerFields,
        activePanel: null,
        visibleTabs: [{ id: 'tab', type: 'terminal', terminal: 'terminal' }],
        showConnectionRetry: retry,
        connectionEscalated: retry,
        bulkCloseConfirm: { visible: false }
      })}
    />
  )
  const mounted: { renderer?: ReactTestRenderer } = {}
  act(() => {
    mounted.renderer = create(screen(true), {
      createNodeMock: (node) => ({
        measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => {
          if (
            node.props !== null &&
            typeof node.props === 'object' &&
            'collapsable' in node.props &&
            node.props.collapsable === false
          ) {
            pending.push(() => done(20, 10, 627, 290))
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
  act(() => {
    root.findByProps({ collapsable: false }).props.onLayout({
      nativeEvent: { layout: { width: 627, height: 290 } }
    })
  })
  act(() => root.findByProps({ 'aria-expanded': false }).props.onPress())
  act(() => pending.shift()?.())
  act(() => overlay.motions.at(-1)?.()())
  expect(root.findByType(AnchoredDetailCard).props.active).toBe(true)
  expect(overlay.back).not.toBeNull()
  act(() => renderer.update(screen(false)))
  expect(root.findAll((node) => node.props['aria-expanded'] !== undefined)).toHaveLength(0)
  expect(root.findByType(AnchoredDetailCard).props).toMatchObject({
    target: 0,
    active: false,
    obscured: true
  })
  expect(detailsCard(root).props.pointerEvents).toBe('none')
  expect(detailsCard(root).props['aria-hidden']).toBe(true)
  expect(overlay.back).toBeNull()
  act(() => renderer.update(screen(true)))
  act(() => root.findByProps({ 'aria-expanded': false }).props.onPress())
  expect(pending).toHaveLength(1)
  act(() => renderer.update(screen(false)))
  act(() => pending.shift()?.())
  expect(root.findByType(AnchoredDetailCard).props).toMatchObject({ target: 0, active: false })
  expect(overlay.back).toBeNull()
  act(() => overlay.motions.at(-1)?.()())
  expect(root.findAllByType(AnchoredDetailCard)).toHaveLength(0)
  act(() => renderer.unmount())
})
