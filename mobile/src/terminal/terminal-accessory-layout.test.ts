import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ROW_DIVIDER_ID_PREFIX,
  TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
  createTerminalAccessoryLayoutPreference,
  getDefaultTerminalAccessoryBuiltInIds,
  getDefaultTerminalAccessoryLayout,
  getVisibleTerminalAccessoryKeys,
  getVisibleTerminalAccessoryRows,
  loadTerminalAccessoryLayout,
  normalizeTerminalAccessoryLayoutPreference,
  parseTerminalAccessoryReorderIds,
  reconcileTerminalAccessoryLayoutCustomKeys,
  reorderTerminalAccessoryBuiltInIds,
  saveTerminalAccessoryLayout,
  setTerminalAccessoryBuiltInVisible,
  setTerminalAccessoryRowCount,
  updateTerminalAccessoryRows
} from './terminal-accessory-layout'

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock
}))

function oldBuiltInIdsBeforeSpace(): string[] {
  return getDefaultTerminalAccessoryBuiltInIds().filter((id) => id !== 'space')
}

describe('terminal accessory layout', () => {
  beforeEach(() => {
    asyncStorageMock.getItem.mockReset()
    asyncStorageMock.setItem.mockReset()
  })

  it('defaults include Space near Enter, Tab, and Shift+Tab', () => {
    const ids = getDefaultTerminalAccessoryBuiltInIds()

    expect(ids).toContain('enter')
    expect(ids).toContain('space')
    expect(ids.indexOf('space')).toBeGreaterThan(ids.indexOf('shiftTab'))
    expect(ids.indexOf('space')).toBeLessThan(ids.indexOf('backspace'))
    expect(ids.indexOf('space')).toBeLessThan(ids.indexOf('delete'))
    expect(ids.indexOf('space')).toBeLessThan(ids.indexOf('arrowUp'))
    expect(getVisibleTerminalAccessoryKeys(ids)).toContainEqual(
      expect.objectContaining({ id: 'space', bytes: ' ', accessibilityLabel: 'Space' })
    )
  })

  it('default layout shows every built-in in canonical order on 1 row', () => {
    const ids = getDefaultTerminalAccessoryBuiltInIds()
    expect(getDefaultTerminalAccessoryLayout()).toEqual({
      rowCount: 1,
      rows: [ids],
      orderedBuiltInIds: ids,
      visibleBuiltInIds: ids
    })
  })

  it('normalizes invalid storage to defaults', () => {
    expect(normalizeTerminalAccessoryLayoutPreference(null).visibleBuiltInIds).toEqual(
      getDefaultTerminalAccessoryBuiltInIds()
    )
    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 1,
        visibleBuiltInIds: ['escape']
      }).visibleBuiltInIds
    ).toEqual(getDefaultTerminalAccessoryBuiltInIds())
    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 2,
        visibleBuiltInIds: ['escape']
      }).visibleBuiltInIds
    ).toEqual(getDefaultTerminalAccessoryBuiltInIds())
    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 3,
        visibleBuiltInIds: ['escape']
      }).visibleBuiltInIds
    ).toEqual(getDefaultTerminalAccessoryBuiltInIds())
  })

  it('returns defaults for corrupt or unreadable storage', async () => {
    asyncStorageMock.getItem.mockResolvedValueOnce('{')
    await expect(loadTerminalAccessoryLayout()).resolves.toEqual(
      createTerminalAccessoryLayoutPreference(getDefaultTerminalAccessoryLayout())
    )

    asyncStorageMock.getItem.mockRejectedValueOnce(new Error('unreadable'))
    await expect(loadTerminalAccessoryLayout()).resolves.toEqual(
      createTerminalAccessoryLayoutPreference(getDefaultTerminalAccessoryLayout())
    )
  })

  it('migrates a custom v2 order and its visible subset to v3', () => {
    const reversed = [...getDefaultTerminalAccessoryBuiltInIds()].toReversed()

    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 2,
        orderedBuiltInIds: reversed,
        visibleBuiltInIds: ['tab', 'escape']
      })
    ).toEqual({
      version: 3,
      rowCount: 1,
      rows: [reversed],
      orderedBuiltInIds: reversed,
      visibleBuiltInIds: ['tab', 'escape']
    })
  })

  it('ignores removed ids and de-dupes ids in v2 storage', () => {
    const current = ['escape', 'tab', 'enter']

    expect(
      normalizeTerminalAccessoryLayoutPreference(
        {
          version: 2,
          orderedBuiltInIds: ['tab', 'removed', 'tab', 'escape', 'enter'],
          visibleBuiltInIds: ['escape', 'removed', 'escape', 'tab']
        },
        current
      )
    ).toEqual({
      version: 3,
      rowCount: 1,
      rows: [['tab', 'escape', 'enter']],
      orderedBuiltInIds: ['tab', 'escape', 'enter'],
      visibleBuiltInIds: ['tab', 'escape']
    })
  })

  it('inserts new built-ins next to their canonical neighbors in a custom order', () => {
    const current = ['escape', 'tab', 'space', 'enter']

    expect(
      normalizeTerminalAccessoryLayoutPreference(
        {
          version: 2,
          orderedBuiltInIds: ['enter', 'tab', 'escape'],
          visibleBuiltInIds: ['enter', 'escape']
        },
        current
      )
    ).toEqual({
      version: 3,
      rowCount: 1,
      // Why asserted: 'space' follows its canonical predecessor 'tab' even
      // though the user moved 'tab' into the middle of the bar.
      rows: [['enter', 'tab', 'space', 'escape']],
      orderedBuiltInIds: ['enter', 'tab', 'space', 'escape'],
      visibleBuiltInIds: ['enter', 'space', 'escape']
    })
  })

  it('inserts new built-ins into the same row as their canonical neighbor in v3 multi-row layout', () => {
    const current = ['escape', 'tab', 'space', 'enter']

    expect(
      normalizeTerminalAccessoryLayoutPreference(
        {
          version: 3,
          rowCount: 2,
          rows: [['enter'], ['custom-1', 'tab', 'escape']],
          visibleBuiltInIds: ['enter', 'escape']
        },
        current
      )
    ).toEqual({
      version: 3,
      rowCount: 2,
      rows: [['enter'], ['custom-1', 'tab', 'space', 'escape']],
      orderedBuiltInIds: ['enter', 'tab', 'space', 'escape'],
      visibleBuiltInIds: ['enter', 'space', 'escape']
    })
  })

  it('puts a new built-in with no surviving predecessor at the front', () => {
    const current = ['escape', 'tab', 'enter']

    expect(
      normalizeTerminalAccessoryLayoutPreference(
        {
          version: 2,
          orderedBuiltInIds: ['enter', 'tab'],
          visibleBuiltInIds: ['enter']
        },
        current
      ).orderedBuiltInIds
    ).toEqual(['escape', 'enter', 'tab'])
  })

  it('migrates v1 layouts to canonical order on v3', () => {
    const ids = getDefaultTerminalAccessoryBuiltInIds()
    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 1,
        visibleBuiltInIds: ['tab', 'escape'],
        knownBuiltInIds: ids
      })
    ).toEqual({
      version: 3,
      rowCount: 1,
      rows: [ids],
      orderedBuiltInIds: ids,
      visibleBuiltInIds: ['escape', 'tab']
    })
  })

  it('appends new defaults only when absent from v1 known ids', () => {
    const current = ['escape', 'tab', 'enter']

    expect(
      normalizeTerminalAccessoryLayoutPreference(
        {
          version: 1,
          visibleBuiltInIds: ['escape'],
          knownBuiltInIds: ['escape', 'tab']
        },
        current
      ).visibleBuiltInIds
    ).toEqual(['escape', 'enter'])

    expect(
      normalizeTerminalAccessoryLayoutPreference(
        {
          version: 1,
          visibleBuiltInIds: ['escape'],
          knownBuiltInIds: current
        },
        current
      ).visibleBuiltInIds
    ).toEqual(['escape'])
  })

  it('migrates Space into old personalized layouts using current built-in order', () => {
    const oldBuiltInIds = oldBuiltInIdsBeforeSpace()

    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 1,
        visibleBuiltInIds: ['escape', 'tab', 'enter', 'shiftTab', 'backspace', 'delete'],
        knownBuiltInIds: oldBuiltInIds
      }).visibleBuiltInIds
    ).toEqual(['escape', 'tab', 'enter', 'shiftTab', 'space', 'backspace', 'delete'])
  })

  it('shows Space once for an all-hidden old layout', () => {
    const oldBuiltInIds = oldBuiltInIdsBeforeSpace()

    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 1,
        visibleBuiltInIds: [],
        knownBuiltInIds: oldBuiltInIds
      }).visibleBuiltInIds
    ).toEqual(['space'])
  })

  it('keeps hidden built-ins hidden across v3 round-trips', () => {
    const visibleBuiltInIds = getDefaultTerminalAccessoryBuiltInIds().filter((id) => id !== 'space')
    const persisted = createTerminalAccessoryLayoutPreference({
      orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
      visibleBuiltInIds
    })

    expect(persisted.orderedBuiltInIds).toContain('space')
    expect(normalizeTerminalAccessoryLayoutPreference(persisted).visibleBuiltInIds).not.toContain(
      'space'
    )
  })

  it('keeps hidden known defaults hidden, including an all-hidden layout', () => {
    const current = ['escape', 'tab', 'enter']

    expect(
      normalizeTerminalAccessoryLayoutPreference(
        {
          version: 2,
          orderedBuiltInIds: current,
          visibleBuiltInIds: []
        },
        current
      ).visibleBuiltInIds
    ).toEqual([])
  })

  it('toggles visibility while preserving the custom order and rows', () => {
    const layout = { orderedBuiltInIds: ['tab', 'escape'], visibleBuiltInIds: ['tab'] }

    expect(setTerminalAccessoryBuiltInVisible(layout, 'escape', true, ['escape', 'tab'])).toEqual({
      rowCount: 1,
      rows: [['tab', 'escape']],
      orderedBuiltInIds: ['tab', 'escape'],
      visibleBuiltInIds: ['tab', 'escape']
    })
    expect(
      setTerminalAccessoryBuiltInVisible(
        { orderedBuiltInIds: ['tab', 'escape'], visibleBuiltInIds: ['tab', 'escape'] },
        'tab',
        false,
        ['escape', 'tab']
      ).visibleBuiltInIds
    ).toEqual(['escape'])
    expect(setTerminalAccessoryBuiltInVisible(layout, 'unknown', true, ['escape', 'tab'])).toEqual({
      rowCount: 1,
      rows: [['tab', 'escape']],
      orderedBuiltInIds: ['tab', 'escape'],
      visibleBuiltInIds: ['tab']
    })
  })

  it('reorders built-ins and keeps the visible subset in the new order', () => {
    const layout = {
      orderedBuiltInIds: ['escape', 'tab', 'enter'],
      visibleBuiltInIds: ['escape', 'enter']
    }

    expect(
      reorderTerminalAccessoryBuiltInIds(
        layout,
        ['enter', 'escape', 'tab'],
        ['escape', 'tab', 'enter']
      )
    ).toEqual({
      rowCount: 1,
      rows: [['enter', 'escape', 'tab']],
      orderedBuiltInIds: ['enter', 'escape', 'tab'],
      visibleBuiltInIds: ['enter', 'escape']
    })

    // Why asserted: a stale drag result missing an id must not drop that key.
    expect(
      reorderTerminalAccessoryBuiltInIds(layout, ['enter', 'escape'], ['escape', 'tab', 'enter'])
        .orderedBuiltInIds
    ).toEqual(['enter', 'escape', 'tab'])
  })

  it('increments rowCount up to 4 and merges trailing rows when decremented', () => {
    const current = ['escape', 'tab', 'enter']
    const initial = {
      rowCount: 1,
      rows: [['escape', 'tab', 'enter']],
      orderedBuiltInIds: current,
      visibleBuiltInIds: current
    }

    const threeRows = setTerminalAccessoryRowCount(initial, 3, current)
    expect(threeRows).toEqual({
      rowCount: 3,
      rows: [['escape', 'tab', 'enter'], [], []],
      orderedBuiltInIds: current,
      visibleBuiltInIds: current
    })

    const clampedMax = setTerminalAccessoryRowCount(threeRows, 9, current)
    expect(clampedMax.rowCount).toBe(4)
    expect(clampedMax.rows).toHaveLength(4)

    const distributed = updateTerminalAccessoryRows(
      threeRows,
      [['custom-a', 'escape'], ['tab'], ['custom-b', 'enter']],
      current
    )
    expect(distributed).toEqual({
      rowCount: 3,
      rows: [['custom-a', 'escape'], ['tab'], ['custom-b', 'enter']],
      orderedBuiltInIds: ['escape', 'tab', 'enter'],
      visibleBuiltInIds: ['escape', 'tab', 'enter']
    })

    const twoRows = setTerminalAccessoryRowCount(distributed, 2, current)
    expect(twoRows).toEqual({
      rowCount: 2,
      rows: [
        ['custom-a', 'escape'],
        ['tab', 'custom-b', 'enter']
      ],
      orderedBuiltInIds: ['escape', 'tab', 'enter'],
      visibleBuiltInIds: ['escape', 'tab', 'enter']
    })

    const oneRow = setTerminalAccessoryRowCount(twoRows, 0, current)
    expect(oneRow).toEqual({
      rowCount: 1,
      rows: [['custom-a', 'escape', 'tab', 'custom-b', 'enter']],
      orderedBuiltInIds: ['escape', 'tab', 'enter'],
      visibleBuiltInIds: ['escape', 'tab', 'enter']
    })
  })

  it('reconciles custom keys and resolves unified multi-row bar items with custom keys before built-ins', () => {
    const current = ['escape', 'tab', 'enter']
    const layout = updateTerminalAccessoryRows(
      {
        rowCount: 2,
        rows: [
          ['custom-first', 'escape', 'custom-removed'],
          ['tab', 'enter']
        ],
        orderedBuiltInIds: current,
        visibleBuiltInIds: ['escape', 'enter']
      },
      [
        ['custom-first', 'escape', 'custom-removed'],
        ['tab', 'enter']
      ],
      current
    )

    const customKeys = [
      { id: 'custom-first', label: ':wq', bytes: ':wq\r' },
      { id: 'custom-new', label: 'gst', bytes: 'git status\r' }
    ]

    const reconciled = reconcileTerminalAccessoryLayoutCustomKeys(
      layout,
      customKeys.map((k) => k.id),
      current
    )
    expect(reconciled.rows).toEqual([
      ['custom-first', 'escape'],
      ['tab', 'enter', 'custom-new']
    ])

    const visibleRows = getVisibleTerminalAccessoryRows(layout, customKeys, current)
    expect(visibleRows).toHaveLength(2)
    expect(visibleRows[0]!.map((item) => `${item.kind}:${item.key.id}`)).toEqual([
      'custom:custom-first',
      'built-in:escape'
    ])
    expect(visibleRows[1]!.map((item) => `${item.kind}:${item.key.id}`)).toEqual([
      'built-in:enter',
      'custom:custom-new'
    ])
  })

  it('parses flat drag-reorder sequences across row divider markers', () => {
    const orderedIds = [
      'custom-1',
      'escape',
      `${ROW_DIVIDER_ID_PREFIX}1__`,
      'tab',
      `${ROW_DIVIDER_ID_PREFIX}2__`,
      'enter',
      'custom-2'
    ]
    expect(parseTerminalAccessoryReorderIds(orderedIds, 3)).toEqual([
      ['custom-1', 'escape'],
      ['tab'],
      ['enter', 'custom-2']
    ])
  })

  it('keeps visible terminal keys in the order of their ids', () => {
    expect(getVisibleTerminalAccessoryKeys(['enter', 'escape']).map((key) => key.id)).toEqual([
      'enter',
      'escape'
    ])
  })

  it('saves the sanitized v3 preference', async () => {
    asyncStorageMock.setItem.mockResolvedValueOnce(undefined)

    await saveTerminalAccessoryLayout({
      orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
      visibleBuiltInIds: ['tab', 'tab', 'missing']
    })

    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
      JSON.stringify(
        createTerminalAccessoryLayoutPreference({
          orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
          visibleBuiltInIds: ['tab']
        })
      )
    )
  })

  it('rejects write failures without mutating helper output', async () => {
    asyncStorageMock.setItem.mockRejectedValueOnce(new Error('nope'))

    await expect(
      saveTerminalAccessoryLayout({
        orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
        visibleBuiltInIds: ['escape']
      })
    ).rejects.toThrow('nope')
    expect(
      createTerminalAccessoryLayoutPreference({
        orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
        visibleBuiltInIds: ['escape']
      }).visibleBuiltInIds
    ).toEqual(['escape'])
  })
})
