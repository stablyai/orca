import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  const held: { raw: string | null } = { raw: null }
  return held
})

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => store.raw,
    setItem: async (_key: string, value: string) => {
      store.raw = value
    }
  }
}))

import { retainMirroredStorage } from '../../storage/mirrored-storage-keys'
import {
  ROW_DIVIDER_ID_PREFIX,
  TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
  getVisibleTerminalAccessoryBuiltInRows,
  loadTerminalAccessoryLayout,
  normalizeTerminalAccessoryLayoutPreference,
  reorderTerminalAccessoryBuiltInRows,
  saveTerminalAccessoryLayout,
  saveTerminalSmartRail,
  setTerminalAccessoryBuiltInVisible,
  setTerminalAccessoryRowCount,
  type TerminalAccessoryLayout
} from './terminal-accessory-layout'

let releaseStorage = () => {}

afterEach(() => releaseStorage())

beforeEach(() => {
  releaseStorage = retainMirroredStorage([TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY])
  store.raw = null
})

describe('terminal-accessory-layout multi-row preferences', () => {
  const canonicalIds = ['escape', 'tab', 'ctrlC', 'arrowUp', 'arrowDown']

  it('migrates v1 and v2 persisted payloads into version 3 single-row format', () => {
    const v1 = normalizeTerminalAccessoryLayoutPreference(
      {
        version: 1,
        visibleBuiltInIds: ['tab', 'ctrlC'],
        knownBuiltInIds: ['escape', 'tab', 'ctrlC'],
        directionPadEnabled: false,
        smartRail: true
      },
      canonicalIds
    )

    expect(v1).toEqual({
      version: 3,
      rowCount: 1,
      rows: [['escape', 'tab', 'ctrlC', 'arrowUp', 'arrowDown']],
      orderedBuiltInIds: ['escape', 'tab', 'ctrlC', 'arrowUp', 'arrowDown'],
      visibleBuiltInIds: ['tab', 'ctrlC', 'arrowUp', 'arrowDown'],
      directionPadEnabled: false,
      smartRail: true
    })

    const v2 = normalizeTerminalAccessoryLayoutPreference(
      {
        version: 2,
        orderedBuiltInIds: ['ctrlC', 'escape', 'tab'],
        visibleBuiltInIds: ['ctrlC', 'escape'],
        directionPadEnabled: true,
        smartRail: false
      },
      canonicalIds
    )

    expect(v2).toEqual({
      version: 3,
      rowCount: 1,
      rows: [['ctrlC', 'arrowUp', 'arrowDown', 'escape', 'tab']],
      orderedBuiltInIds: ['ctrlC', 'arrowUp', 'arrowDown', 'escape', 'tab'],
      visibleBuiltInIds: ['ctrlC', 'arrowUp', 'arrowDown', 'escape'],
      directionPadEnabled: true,
      smartRail: false
    })
  })

  it('clamps rowCount between 1 and 4 and merges trailing rows when shrinking', () => {
    const base: TerminalAccessoryLayout = {
      rowCount: 1,
      rows: [['escape', 'tab', 'ctrlC', 'arrowUp']],
      orderedBuiltInIds: ['escape', 'tab', 'ctrlC', 'arrowUp'],
      visibleBuiltInIds: ['escape', 'tab', 'ctrlC', 'arrowUp']
    }
    const fourIds = ['escape', 'tab', 'ctrlC', 'arrowUp']

    const grown = setTerminalAccessoryRowCount(base, 6, fourIds)
    expect(grown.rowCount).toBe(4)
    expect(grown.rows).toEqual([['escape', 'tab', 'ctrlC', 'arrowUp'], [], [], []])

    const populated: TerminalAccessoryLayout = {
      ...grown,
      rows: [['escape'], ['tab'], ['ctrlC'], ['arrowUp']]
    }
    const shrunk = setTerminalAccessoryRowCount(populated, 2, fourIds)
    expect(shrunk.rowCount).toBe(2)
    expect(shrunk.rows).toEqual([['escape'], ['tab', 'ctrlC', 'arrowUp']])
    expect(shrunk.orderedBuiltInIds).toEqual(['escape', 'tab', 'ctrlC', 'arrowUp'])

    const clampedLow = setTerminalAccessoryRowCount(shrunk, 0, fourIds)
    expect(clampedLow.rowCount).toBe(1)
    expect(clampedLow.rows).toEqual([['escape', 'tab', 'ctrlC', 'arrowUp']])
  })

  it('partitions keys across divider ids on reorder and preserves hidden selections', () => {
    const fourIds = ['escape', 'tab', 'ctrlC', 'arrowUp']
    const initial: TerminalAccessoryLayout = {
      rowCount: 3,
      rows: [['escape', 'tab'], ['ctrlC'], ['arrowUp']],
      orderedBuiltInIds: ['escape', 'tab', 'ctrlC', 'arrowUp'],
      visibleBuiltInIds: ['escape', 'ctrlC']
    }

    const reordered = reorderTerminalAccessoryBuiltInRows(
      initial,
      [
        'ctrlC',
        `${ROW_DIVIDER_ID_PREFIX}2`,
        'escape',
        'arrowUp',
        `${ROW_DIVIDER_ID_PREFIX}3`,
        'tab'
      ],
      fourIds
    )

    expect(reordered.rows).toEqual([['ctrlC'], ['escape', 'arrowUp'], ['tab']])
    expect(reordered.orderedBuiltInIds).toEqual(['ctrlC', 'escape', 'arrowUp', 'tab'])
    expect(reordered.visibleBuiltInIds).toEqual(['ctrlC', 'escape'])
  })

  it('preserves multi-row partitions on visibility toggles and smart rail writes', async () => {
    const fourIds = ['escape', 'tab', 'ctrlC', 'arrowUp']
    const layout: TerminalAccessoryLayout = {
      rowCount: 2,
      rows: [
        ['escape', 'tab'],
        ['ctrlC', 'arrowUp']
      ],
      orderedBuiltInIds: ['escape', 'tab', 'ctrlC', 'arrowUp'],
      visibleBuiltInIds: ['escape', 'tab', 'ctrlC'],
      directionPadEnabled: true,
      smartRail: false
    }

    const toggled = setTerminalAccessoryBuiltInVisible(layout, 'tab', false, fourIds)
    expect(toggled.rowCount).toBe(2)
    expect(toggled.rows).toEqual([
      ['escape', 'tab'],
      ['ctrlC', 'arrowUp']
    ])
    expect(toggled.visibleBuiltInIds).toEqual(['escape', 'ctrlC'])

    await saveTerminalAccessoryLayout({
      rowCount: 2,
      rows: [['escape', 'tab'], ['ctrlC']],
      orderedBuiltInIds: ['escape', 'tab', 'ctrlC'],
      visibleBuiltInIds: ['escape', 'ctrlC'],
      directionPadEnabled: true,
      smartRail: false
    })
    await saveTerminalSmartRail(true)

    const loaded = await loadTerminalAccessoryLayout()
    expect(loaded.version).toBe(3)
    expect(loaded.rowCount).toBe(2)
    expect(loaded.smartRail).toBe(true)
    expect(loaded.rows[0]).toContain('escape')
    expect(loaded.rows[1]).toContain('ctrlC')
  })

  it('maps visible keys per row and includes arrow keys when includeDirectionKeys is true', () => {
    const layout: TerminalAccessoryLayout = {
      rowCount: 2,
      rows: [
        ['escape', 'tab'],
        ['ctrlC', 'arrowUp']
      ],
      orderedBuiltInIds: ['escape', 'tab', 'ctrlC', 'arrowUp'],
      visibleBuiltInIds: ['escape', 'ctrlC']
    }

    const withoutArrows = getVisibleTerminalAccessoryBuiltInRows(layout, false, [
      'escape',
      'tab',
      'ctrlC',
      'arrowUp'
    ])
    expect(withoutArrows.map((row) => row.map((key) => key.id))).toEqual([['escape'], ['ctrlC']])

    const withArrows = getVisibleTerminalAccessoryBuiltInRows(layout, true, [
      'escape',
      'tab',
      'ctrlC',
      'arrowUp'
    ])
    expect(withArrows.map((row) => row.map((key) => key.id))).toEqual([
      ['escape'],
      ['ctrlC', 'arrowUp']
    ])
  })
})
