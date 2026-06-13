import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
  createTerminalAccessoryLayoutPreference,
  getDefaultTerminalAccessoryBuiltInIds,
  getDefaultTerminalAccessoryLayout,
  getVisibleTerminalAccessoryKeys,
  loadTerminalAccessoryLayout,
  normalizeTerminalAccessoryLayoutPreference,
  reorderTerminalAccessoryBuiltInIds,
  saveTerminalAccessoryLayout,
  setTerminalAccessoryBuiltInVisible
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

  it('default layout shows every built-in in canonical order', () => {
    expect(getDefaultTerminalAccessoryLayout()).toEqual({
      orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
      visibleBuiltInIds: getDefaultTerminalAccessoryBuiltInIds()
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

  it('preserves a custom v2 order and its visible subset', () => {
    const reversed = [...getDefaultTerminalAccessoryBuiltInIds()].reverse()

    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 2,
        orderedBuiltInIds: reversed,
        visibleBuiltInIds: ['tab', 'escape']
      })
    ).toEqual({
      version: 2,
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
      version: 2,
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
      version: 2,
      // Why asserted: 'space' follows its canonical predecessor 'tab' even
      // though the user moved 'tab' into the middle of the bar.
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

  it('migrates v1 layouts to canonical order', () => {
    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 1,
        visibleBuiltInIds: ['tab', 'escape'],
        knownBuiltInIds: getDefaultTerminalAccessoryBuiltInIds()
      })
    ).toEqual({
      version: 2,
      orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
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

  it('keeps hidden built-ins hidden across v2 round-trips', () => {
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

  it('toggles visibility while preserving the custom order', () => {
    const layout = { orderedBuiltInIds: ['tab', 'escape'], visibleBuiltInIds: ['tab'] }

    expect(setTerminalAccessoryBuiltInVisible(layout, 'escape', true, ['escape', 'tab'])).toEqual({
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
      orderedBuiltInIds: ['enter', 'escape', 'tab'],
      visibleBuiltInIds: ['enter', 'escape']
    })

    // Why asserted: a stale drag result missing an id must not drop that key.
    expect(
      reorderTerminalAccessoryBuiltInIds(layout, ['enter', 'escape'], ['escape', 'tab', 'enter'])
        .orderedBuiltInIds
    ).toEqual(['enter', 'escape', 'tab'])
  })

  it('keeps visible terminal keys in the order of their ids', () => {
    expect(getVisibleTerminalAccessoryKeys(['enter', 'escape']).map((key) => key.id)).toEqual([
      'enter',
      'escape'
    ])
  })

  it('saves the sanitized v2 preference', async () => {
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
