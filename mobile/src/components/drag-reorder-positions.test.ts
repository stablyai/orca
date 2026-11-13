import { expect, it } from 'vitest'
import {
  dragReorderLayout,
  dragReorderTarget,
  dragReorderPositionsFromKeys,
  moveDragReorderKey
} from './drag-reorder-positions'

it('lays out variable-height rows when targeting, reordering and resizing', () => {
  const positions = dragReorderPositionsFromKeys(['row-0', 'row-1', 'row-2', 'row-3'])
  const sizes = { 'row-0': 100, 'row-1': 20, 'row-2': 100, 'row-3': 20 }
  const layout = dragReorderLayout(positions, sizes)
  expect(layout.tops['row-3']).toBe(220)
  expect(dragReorderTarget(positions, sizes, layout, 'row-0', 35)).toBe(1)
  const moved = moveDragReorderKey(positions, 'row-0', 2)
  expect(dragReorderLayout(moved, sizes).keys.slice(0, 3)).toEqual(['row-1', 'row-2', 'row-0'])
  expect(dragReorderLayout(positions, { ...sizes, 'row-0': 200 }).tops['row-1']).toBe(200)
})
