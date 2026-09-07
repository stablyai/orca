import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import { readMobileSessionRouteSource } from './mobile-session-route-source-family.test-support'

type StyleLayer = { top?: number }

// The applied top offset, read off the rendered pane rather than assumed.
function appliedTopOffset(style: unknown): number {
  const layers = (Array.isArray(style) ? style : [style]) as (StyleLayer | null | undefined)[]
  return layers.reduce<number>(
    (top, layer) => (typeof layer?.top === 'number' ? layer.top : top),
    0
  )
}

const engine = vi.hoisted(() => ({
  init: vi.fn((_cols: number, _rows: number) => {}),
  awaitReady: vi.fn(async () => {}),
  measureFitDimensions: vi.fn(async (_containerHeight?: number) => ({ cols: 100, rows: 40 })),
  onWebReady: null as (() => void) | null
}))

vi.mock('react-native', () => ({
  StyleSheet: {
    create: <T>(styles: T) => styles,
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
  },
  View: 'View'
}))

vi.mock('../terminal/TerminalWebView', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    TerminalWebView: forwardRef<TerminalWebViewHandle, { onWebReady?: () => void }>(
      function MockTerminalWebView(props, ref) {
        engine.onWebReady = props.onWebReady ?? null
        useImperativeHandle(ref, () => engine as unknown as TerminalWebViewHandle, [])
        return createElement('MockTerminalWebView')
      }
    )
  }
})

import { TerminalEnginePrewarm } from './TerminalEnginePrewarm'
import {
  MOBILE_SESSION_TAB_BAR_BORDER_WIDTH,
  MOBILE_SESSION_TAB_BAR_CONTENT_HEIGHT,
  MOBILE_SESSION_TAB_BAR_HEIGHT,
  mobileSessionFrameStyles
} from './mobile-session-frame-styles'

// The box the session content row occupies. Both states below live in it, so it is the one
// number the two frame heights are derived from.
const CONTENT_ROW_HEIGHT = 700

// The bar's rendered height, derived from the styles the header actually mounts rather than from
// the constant the pre-warm consumes — otherwise the comparison below would just restate itself.
// React Native sizes a row with no explicit height to its tallest child and puts the border
// outside that, so this is max(children) + border.
function renderedTabBarHeight(): number {
  const row = mobileSessionFrameStyles.tabBar as { height?: number; borderTopWidth: number }
  // An explicit height here would be border-box and would shrink the row below its children.
  expect(row.height).toBeUndefined()
  const tallestChild = Math.max(
    mobileSessionFrameStyles.tabScroll.maxHeight,
    mobileSessionFrameStyles.tab.minHeight,
    mobileSessionFrameStyles.newTerminalButton.height,
    mobileSessionFrameStyles.tabActionDivider.height
  )
  return tallestChild + row.borderTopWidth
}

// What the first real pane gets once its tab exists and the bar mounts above it.
function firstPaneFrameHeight(): number {
  return CONTENT_ROW_HEIGHT - renderedTabBarHeight()
}
const headerSource = readMobileSessionRouteSource('./MobileSessionHeader.tsx')
const activeContentSource = readMobileSessionRouteSource('./MobileSessionActiveContent.tsx')

// Reproduces React Native's absolute-fill layout: a box pinned to every edge of its parent with
// a top offset gets exactly that much less height. The offset is read off the component, never
// assumed, so a pre-warm that stopped reserving the bar would report the taller box here.
function measuredPrewarmHeight(reservedTabBarHeight: number): number {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(
      createElement(TerminalEnginePrewarm, { reservedTabBarHeight, onEngineMeasured: () => {} })
    )
  })
  const created = renderer as unknown as ReactTestRenderer
  const applied = appliedTopOffset(created.root.findAllByType('View')[0]?.props.style)
  act(() => created.unmount())
  return CONTENT_ROW_HEIGHT - applied
}

afterEach(() => {
  engine.measureFitDimensions.mockClear()
  engine.onWebReady = null
})

describe('terminal pre-warm frame geometry', () => {
  it('states the height the bar actually renders at', () => {
    // The constant is what the pre-warm reserves, so it has to equal what the header mounts.
    // Deriving the latter from the styles catches the border-box trap: pinning an explicit
    // height on the row would render it a pixel short of this sum and drift a whole row.
    expect(renderedTabBarHeight()).toBe(MOBILE_SESSION_TAB_BAR_HEIGHT)
    expect(MOBILE_SESSION_TAB_BAR_HEIGHT).toBe(
      MOBILE_SESSION_TAB_BAR_CONTENT_HEIGHT + MOBILE_SESSION_TAB_BAR_BORDER_WIDTH
    )
    expect(mobileSessionFrameStyles.tabBar.borderTopWidth).toBe(MOBILE_SESSION_TAB_BAR_BORDER_WIDTH)
    // Every child is pinned to the content height, so nothing can grow the row unnoticed.
    expect(mobileSessionFrameStyles.tabScroll.maxHeight).toBe(MOBILE_SESSION_TAB_BAR_CONTENT_HEIGHT)
    expect(mobileSessionFrameStyles.tab.minHeight).toBe(MOBILE_SESSION_TAB_BAR_CONTENT_HEIGHT)
    expect(mobileSessionFrameStyles.newTerminalButton.height).toBe(
      MOBILE_SESSION_TAB_BAR_CONTENT_HEIGHT
    )
  })

  it('mounts the tab bar only once a tab is visible, which is what shortens the pane', () => {
    expect(headerSource).toContain(
      '{visibleTabs.length > 0 && (\n        <View style={styles.tabBar}>'
    )
    // So the reservation has to be the exact complement of that condition, read off the same list
    // the header gates on rather than a proxy for it.
    expect(activeContentSource).toContain(
      'const prewarmReservedTabBarHeight = visibleTabs.length > 0 ? 0 : MOBILE_SESSION_TAB_BAR_HEIGHT'
    )
  })

  it('measures the same frame height the first real pane will get', () => {
    // Loading: no visible tab, so no tab bar, so the content row is all the pre-warm's to fill,
    // minus whatever it reserves. Loaded: the first terminal produces a tab, the bar mounts, and
    // the pane gets what is left. The right side is derived from the header's own styles.
    expect(measuredPrewarmHeight(MOBILE_SESSION_TAB_BAR_HEIGHT)).toBe(firstPaneFrameHeight())
  })

  it('would latch a taller frame than the pane if the bar were not reserved', () => {
    // Guards the fix rather than the code: without the reservation the pre-warm measures the
    // pre-tab-bar box, and every row of that difference is a row the host never had.
    const unreserved = measuredPrewarmHeight(0)
    expect(unreserved).toBe(CONTENT_ROW_HEIGHT)
    expect(unreserved - firstPaneFrameHeight()).toBe(renderedTabBarHeight())
  })

  it('hands the engine the reserved height, so no refit is owed after the first subscribe', async () => {
    let measuredWith: number | null = null
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(
        createElement(TerminalEnginePrewarm, {
          reservedTabBarHeight: MOBILE_SESSION_TAB_BAR_HEIGHT,
          textScale: 1,
          onEngineMeasured: (_ref: unknown, frameHeight: number) => {
            measuredWith = frameHeight
          }
        })
      )
    })
    const created = renderer as unknown as ReactTestRenderer
    const pane = created.root.findAllByType('View')[0]
    const applied = appliedTopOffset(pane?.props.style)
    act(() => {
      pane?.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: CONTENT_ROW_HEIGHT - applied } }
      })
    })
    act(() => {
      engine.onWebReady?.()
    })
    // The handoff waits on the engine's ready promise, so let those microtasks land.
    await act(async () => {})

    // The height the latched viewport is computed from equals the real pane's frame height, so
    // the frame-height refit re-measures the same cols/rows and returns before it would send
    // terminal.updateViewport (see the prev-dims guard in terminal-viewport-refit.ts).
    expect(measuredWith).toBe(firstPaneFrameHeight())
    act(() => created.unmount())
  })
})
