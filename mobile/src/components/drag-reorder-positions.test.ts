import { describe, expect, it } from 'vitest'

import {
  clampDragReorderIndex,
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
