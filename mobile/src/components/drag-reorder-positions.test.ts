import { describe, expect, it } from 'vitest'

import {
  clampDragReorderIndex,
  dragReorderLayout,
  dragReorderTarget,
  dragReorderPositionsFromKeys,
  moveDragReorderKey,
  orderedKeysFromDragReorderPositions
} from './drag-reorder-positions'

describe('drag reorder positions', () => {
  it('round-trips keys through positions', () => {
    const keys = ['escape', 'tab', 'enter']
    expect(orderedKeysFromDragReorderPositions(dragReorderPositionsFromKeys(keys))).toEqual(keys)
  })

  it('clamps drag indexes to the list bounds', () => {
    expect(clampDragReorderIndex(-2, 3)).toBe(0)
    expect(clampDragReorderIndex(1, 3)).toBe(1)
    expect(clampDragReorderIndex(7, 3)).toBe(2)
    expect(clampDragReorderIndex(0, 0)).toBe(0)
  })

  it('shifts intermediate rows down when dragging a row later', () => {
    const positions = dragReorderPositionsFromKeys(['a', 'b', 'c', 'd'])
    expect(orderedKeysFromDragReorderPositions(moveDragReorderKey(positions, 'a', 2))).toEqual([
      'b',
      'c',
      'a',
      'd'
    ])
  })

  it('shifts intermediate rows up when dragging a row earlier', () => {
    const positions = dragReorderPositionsFromKeys(['a', 'b', 'c', 'd'])
    expect(orderedKeysFromDragReorderPositions(moveDragReorderKey(positions, 'd', 1))).toEqual([
      'a',
      'd',
      'b',
      'c'
    ])
  })

  it('returns the same positions for no-op or unknown moves', () => {
    const positions = dragReorderPositionsFromKeys(['a', 'b'])
    expect(moveDragReorderKey(positions, 'a', 0)).toBe(positions)
    expect(moveDragReorderKey(positions, 'missing', 1)).toBe(positions)
  })
})

it('projects a thousand variable-height rows and all row lookups with linear reads', () => {
  const keys = Array.from({ length: 1000 }, (_, index) => `row-${index}`)
  let reads = 0
  const positions = new Proxy(dragReorderPositionsFromKeys(keys), {
    get(target, key) {
      if (typeof key === 'string') {
        reads++
        return target[key]
      }
      return undefined
    }
  })
  const sizes = Object.fromEntries(keys.map((key, index) => [key, index % 2 ? 20 : 100]))
  const layout = dragReorderLayout(positions, sizes)
  expect(keys.map((key) => layout.tops[key]).at(-1)).toBe(59980)
  expect(reads).toBe(1000)
  expect(dragReorderTarget(positions, sizes, layout, 'row-0', 35)).toBe(1)
  const moved = moveDragReorderKey(positions, 'row-0', 2)
  expect(dragReorderLayout(moved, sizes).keys.slice(0, 3)).toEqual(['row-1', 'row-2', 'row-0'])
  expect(dragReorderLayout(positions, { ...sizes, 'row-0': 200 }).tops['row-1']).toBe(200)
})
