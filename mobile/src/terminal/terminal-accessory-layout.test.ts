import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hasTerminalDirectionPadSpace, type SideRailStrip } from '../layout/side-rail-strip'

import {
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
      directionPadEnabled: true,
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
    const reversed = [...getDefaultTerminalAccessoryBuiltInIds()].toReversed()

    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 2,
        orderedBuiltInIds: reversed,
        visibleBuiltInIds: ['tab', 'escape']
      })
    ).toEqual({
      directionPadEnabled: true,
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
      directionPadEnabled: true,
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
      directionPadEnabled: true,
      version: 2,
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
      directionPadEnabled: true,
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
      directionPadEnabled: true,
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
      directionPadEnabled: true,
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
      directionPadEnabled: true,
      orderedBuiltInIds: ['enter', 'escape', 'tab'],
      visibleBuiltInIds: ['enter', 'escape']
    })

    // Stale drag results must not drop missing ids from the layout.
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
      'orca:terminal-accessory-layout',
      JSON.stringify({
        version: 2,
        directionPadEnabled: true,
        orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
        visibleBuiltInIds: ['tab']
      })
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

it('uses arrow-free Duo defaults only for an untouched layout and preserves explicit choices', async () => {
  asyncStorageMock.getItem.mockResolvedValue(null)
  const duo = await loadTerminalAccessoryLayout(true)
  expect(duo.directionPadEnabled).toBe(true)
  expect(duo.visibleBuiltInIds.filter((id) => id.startsWith('arrow'))).toEqual([])
  const strips: (SideRailStrip | null)[] = [
    null,
    { side: 'right', width: 84, height: 200, top: 0, bottom: 0 },
    { side: 'right', width: 59, height: 500, top: 0, bottom: 0 }
  ]
  for (const strip of strips) {
    expect(
      (await loadTerminalAccessoryLayout(hasTerminalDirectionPadSpace(strip))).visibleBuiltInIds
    ).toContain('arrowUp')
  }
  for (const side of ['left', 'right'] as const) {
    const strip = { side, width: 84, height: 500, top: 0, bottom: 0 }
    expect(
      (await loadTerminalAccessoryLayout(hasTerminalDirectionPadSpace(strip))).visibleBuiltInIds
    ).not.toContain('arrowUp')
  }
  const explicit = setTerminalAccessoryBuiltInVisible(
    { ...duo, directionPadEnabled: false },
    'arrowUp',
    true
  )
  asyncStorageMock.setItem.mockResolvedValue(undefined)
  await saveTerminalAccessoryLayout(explicit)
  const saved = asyncStorageMock.setItem.mock.calls.at(-1)![1]
  asyncStorageMock.getItem.mockResolvedValue(saved)
  expect((await loadTerminalAccessoryLayout(true)).visibleBuiltInIds).toContain('arrowUp')
  expect((await loadTerminalAccessoryLayout(true)).directionPadEnabled).toBe(false)
  expect((await loadTerminalAccessoryLayout(false)).visibleBuiltInIds).toContain('arrowUp')
  const legacy = {
    version: 2,
    orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
    visibleBuiltInIds: ['arrowDown', 'tab']
  }
  asyncStorageMock.getItem.mockResolvedValue(JSON.stringify(legacy))
  expect((await loadTerminalAccessoryLayout(true)).visibleBuiltInIds).toEqual(['tab', 'arrowDown'])
})
