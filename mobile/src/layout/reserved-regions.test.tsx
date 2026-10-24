import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReservedRegion } from 'react-native-reserved-regions'
import type { ReservedRegions } from './reserved-regions-contract'

const native = vi.hoisted(() => ({
  regions: new Array<ReservedRegion>(),
  insets: { left: 0, right: 0, top: 0, bottom: 0 }
}))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => native.insets }))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  useWindowDimensions: () => ({ width: 900, height: 800 })
}))
vi.mock('react-native-reserved-regions', () => ({
  ReservedRegionsProvider: 'MeasuredRegions',
  useReservedRegions: () => native.regions
}))

import { WindowReservedRegionsProvider, useReservedRegions } from './reserved-regions'

type Measurement = (x: number, y: number, width: number, height: number) => void
const measurements: Measurement[] = []
const snapshots: ReservedRegions[] = []
const onLayout = vi.fn()
let tree: ReactTestRenderer | undefined

function Probe(): null {
  snapshots.push(useReservedRegions())
  return null
}

function screen() {
  return createElement(
    WindowReservedRegionsProvider,
    { onLayout, testID: 'root' },
    createElement(Probe)
  )
}

beforeEach(() => {
  measurements.length = 0
  snapshots.length = 0
  onLayout.mockClear()
  native.insets = { left: 0, right: 0, top: 0, bottom: 0 }
  native.regions = [
    { kind: 'division', frame: { x: 400, y: 0, width: 12, height: 760 }, occludesContent: false }
  ]
})

afterEach(() => {
  act(() => tree?.unmount())
})

function mount(): void {
  act(() => {
    tree = create(screen(), {
      createNodeMock: () => ({
        measureInWindow: (measure: Measurement) => measurements.push(measure)
      })
    })
  })
}

function measure(x: number, y: number): void {
  act(() => {
    for (const deliver of measurements.splice(0)) {
      deliver(x, y, 900, 800)
    }
  })
}

it('waits for the root position before handing a window-coordinate fold to the WebView', () => {
  mount()
  expect(snapshots.at(-1)).toEqual({ divisions: [], occlusions: [] })
  measure(20, 40)
  expect(snapshots.at(-1)).toEqual({
    divisions: [{ x: 420, y: 40, width: 12, height: 760 }],
    occlusions: []
  })
})

it('clears a fold when the provider reports no active regions', () => {
  mount()
  measure(0, 0)
  native.regions = []
  act(() => tree?.update(screen()))
  expect(snapshots.at(-1)).toEqual({ divisions: [], occlusions: [] })
})

it('remeasures when the status column changes sides without changing window size', () => {
  mount()
  measure(0, 0)
  native.insets = { left: 84, right: 0, top: 0, bottom: 0 }
  act(() => tree?.update(screen()))
  expect(measurements.length).toBeGreaterThan(0)
  measure(20, 0)
  expect(snapshots.at(-1)?.divisions[0]?.x).toBe(420)
})

it('remeasures on layout and preserves the navigator layout callback', () => {
  mount()
  measure(0, 0)
  const event = { nativeEvent: { layout: { x: 0, y: 0, width: 900, height: 800 } } }
  act(() =>
    tree?.root.find((node) => String(node.type) === 'MeasuredRegions').props.onLayout(event)
  )
  measure(30, 10)
  expect(snapshots.at(-1)?.divisions[0]?.x).toBe(430)
  expect(onLayout).toHaveBeenCalledWith(event)
})
