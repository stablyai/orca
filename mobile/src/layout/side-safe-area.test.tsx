import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { getFoldSplit, type FoldSplit } from './fold-division'
import type { ReservedRegions } from '../../modules/orca-reserved-regions/src'
import type { EdgeInsets, Rect } from 'react-native-safe-area-context'

const renderers = new Set<ReturnType<typeof createRenderer>>()
function create(...args: Parameters<typeof createRenderer>): ReturnType<typeof createRenderer> {
  const renderer = createRenderer(...args)
  renderers.add(renderer)
  return renderer
}
function unmountRenderers(): void {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
}

const geometry = vi.hoisted((): { regions: ReservedRegions; platform: { OS: string } } => ({
  regions: { divisions: [], occlusions: [] },
  platform: { OS: 'ios' }
}))
vi.mock('./reserved-regions', () => ({ useReservedRegions: () => geometry.regions }))
vi.mock('react-native', () => ({
  Platform: geometry.platform,
  View: 'View',
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('react-native-safe-area-context', async () => {
  const { createContext, useContext } = await import('react')
  const SafeAreaInsetsContext = createContext<EdgeInsets | null>(null)
  const SafeAreaFrameContext = createContext<Rect | null>(null)
  return {
    SafeAreaInsetsContext,
    SafeAreaFrameContext,
    SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
    useSafeAreaInsets: () => useContext(SafeAreaInsetsContext),
    useSafeAreaFrame: () => useContext(SafeAreaFrameContext)
  }
})

const { SafeAreaFrameContext, SafeAreaInsetsContext, useSafeAreaFrame, useSafeAreaInsets } =
  await import('react-native-safe-area-context')
const { SideSafeArea, useWindowSafeAreaInsets } = await import('./side-safe-area')

// Unequal sides, so a swapped edge shows.
const WINDOW = { top: 0, right: 48, bottom: 21, left: 59 }
const FRAME = { x: 0, y: 0, width: 852, height: 393 }

function renderInLandscape(window = WINDOW, frame = FRAME, nested = false) {
  const read: { screen?: EdgeInsets; frame?: Rect; modal?: EdgeInsets; fold?: FoldSplit | null } =
    {}
  function Probe() {
    read.screen = useSafeAreaInsets()
    read.frame = useSafeAreaFrame()
    read.fold = getFoldSplit(geometry.regions.divisions, read.frame)
    read.modal = useWindowSafeAreaInsets()
    return null
  }
  let tree: ReactTestRenderer | undefined
  act(() => {
    tree = create(
      <SafeAreaFrameContext.Provider value={frame}>
        <SafeAreaInsetsContext.Provider value={window}>
          <SideSafeArea>
            {nested ? (
              <SideSafeArea>
                <Probe />
              </SideSafeArea>
            ) : (
              <Probe />
            )}
          </SideSafeArea>
        </SafeAreaInsetsContext.Provider>
      </SafeAreaFrameContext.Provider>
    )
  })
  return { tree: tree!, read }
}

describe('the app laid out clear of the side insets', () => {
  it('pads the sides once, and screens below see the padded area', () => {
    const { tree, read } = renderInLandscape()
    const area = tree.root.find((node) => String(node.type) === 'View')
    expect(Object.assign({}, ...[area.props.style].flat())).toMatchObject({
      paddingLeft: 59,
      paddingRight: 48
    })
    expect(read.screen).toEqual({ top: 0, right: 0, bottom: 21, left: 0 })
    expect(read.frame).toEqual({ x: 59, y: 0, width: 745, height: 393 })
  })

  it('gives a Modal, which opens a window of its own, the window insets', () => {
    expect(renderInLandscape().read.modal).toEqual(WINDOW)
  })
})

afterEach(() => {
  unmountRenderers()
  geometry.regions = { divisions: [], occlusions: [] }
  geometry.platform.OS = 'ios'
})

const DUO_FRAME = { x: 0, y: 0, width: 951, height: 669 }
const DUO_INSETS = { top: 0, right: 84, bottom: 34, left: 0 }
function duoGeometry() {
  geometry.regions = {
    divisions: [],
    occlusions: [{ x: 867, y: 0, width: 84, height: 120 }],
    windowSafeArea: { bounds: DUO_FRAME, insets: DUO_INSETS }
  }
}
function topPadding(tree: ReactTestRenderer) {
  return tree.root
    .findAll((node) => String(node.type) === 'View')
    .map((node) => Object.assign({}, ...[node.props.style].flat()).paddingTop ?? 0)
}

it('keeps the full Duo height without adding a top band across nested areas', () => {
  duoGeometry()
  const { tree, read } = renderInLandscape(DUO_INSETS, DUO_FRAME, true)
  expect(topPadding(tree)).toEqual([0, 0])
  expect(read.frame).toEqual({ x: 0, y: 0, width: 867, height: 669 })
  expect(read.screen).toEqual({ top: 0, right: 0, bottom: 34, left: 0 })
})

it('adds no Duo edge spacing when the keyboard changes or a banner offsets the frame', () => {
  duoGeometry()
  geometry.regions.keyboardInset = 600
  expect(topPadding(renderInLandscape(DUO_INSETS, DUO_FRAME).tree)).toEqual([0])
  expect(topPadding(renderInLandscape(DUO_INSETS, { ...DUO_FRAME, y: 12 }).tree)).toEqual([0])
  expect(topPadding(renderInLandscape(DUO_INSETS, { ...DUO_FRAME, y: 30 }).tree)).toEqual([0])
})

it.each(['web', 'android'])('does not apply the native Duo workaround on %s', (platform) => {
  duoGeometry()
  geometry.platform.OS = platform
  expect(topPadding(renderInLandscape(DUO_INSETS, DUO_FRAME).tree)).toEqual([0])
})

it('leaves portrait top-safe-area donation and ordinary iPad/phone geometry unchanged', () => {
  geometry.regions = {
    divisions: [],
    occlusions: [{ x: 470, y: 0, width: 199, height: 84 }],
    windowSafeArea: {
      bounds: { x: 0, y: 0, width: 669, height: 951 },
      insets: { top: 84, right: 0, bottom: 34, left: 0 }
    }
  }
  expect(
    topPadding(
      renderInLandscape(
        { top: 84, right: 0, bottom: 34, left: 0 },
        { x: 0, y: 0, width: 669, height: 951 }
      ).tree
    )
  ).toEqual([0])
  geometry.regions = { divisions: [], occlusions: [] }
  expect(topPadding(renderInLandscape().tree)).toEqual([0])
})

it.each([
  {
    division: { x: 0, y: 320, width: 951, height: 20 },
    expected: { axis: 'horizontal', start: 320, end: 340, size: 669 }
  },
  {
    division: { x: 430, y: 0, width: 10, height: 669 },
    expected: { axis: 'vertical', start: 430, end: 440, size: 867 }
  }
])(
  'keeps the window hinge aligned without a synthetic top offset: $expected.axis',
  ({ division, expected }) => {
    duoGeometry()
    geometry.regions.divisions = [division]
    const { read, tree } = renderInLandscape(DUO_INSETS, DUO_FRAME, true)
    expect(topPadding(tree)).toEqual([0, 0])
    expect(read.frame).toEqual({ x: 0, y: 0, width: 867, height: 669 })
    expect(read.fold).toEqual(expected)
  }
)

it('preserves genuine top insets for the screen and modal without a synthetic guard', () => {
  duoGeometry()
  const { tree, read } = renderInLandscape({ ...DUO_INSETS, top: 18 }, DUO_FRAME)
  expect(topPadding(tree)).toEqual([0])
  expect(read.screen?.top).toBe(18)
  expect(read.modal?.top).toBe(18)
})
