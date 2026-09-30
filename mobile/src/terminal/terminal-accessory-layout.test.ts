import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
  createTerminalAccessoryLayoutPreference,
  getDefaultTerminalAccessoryBuiltInIds,
  getDefaultTerminalAccessoryLayout,
  getTerminalAccessoryEntries,
  loadTerminalAccessoryLayout,
  normalizeTerminalAccessoryLayoutPreference,
  reorderTerminalAccessoryIds,
  resetTerminalAccessoryLayout,
  saveTerminalAccessoryLayout,
  setTerminalAccessoryBuiltInVisible
} from './terminal-accessory-layout'
import type { CustomKey } from '../components/CustomKeyModal'

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

function customKey(id: string): CustomKey {
  return { id, label: id, bytes: `/model ${id}\r`, enter: true }
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
    expect(
      getTerminalAccessoryEntries(getDefaultTerminalAccessoryLayout(), []).map((entry) => entry.key)
    ).toContainEqual(
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
    const reversed = [...getDefaultTerminalAccessoryBuiltInIds()].toReversed()

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
      reorderTerminalAccessoryIds(
        layout,
        ['builtin:enter', 'builtin:escape', 'builtin:tab'],
        ['escape', 'tab', 'enter']
      )
    ).toEqual({
      orderedBuiltInIds: ['enter', 'escape', 'tab'],
      visibleBuiltInIds: ['enter', 'escape'],
      orderedIds: ['builtin:enter', 'builtin:escape', 'builtin:tab']
    })

    // Why asserted: a stale drag result missing an id must not drop that key.
    expect(
      reorderTerminalAccessoryIds(
        layout,
        ['builtin:enter', 'builtin:escape'],
        ['escape', 'tab', 'enter']
      ).orderedBuiltInIds
    ).toEqual(['enter', 'escape', 'tab'])
  })

  it('keeps visible terminal keys in the order of their ids', () => {
    const layout = reorderTerminalAccessoryIds(
      {
        ...getDefaultTerminalAccessoryLayout(),
        visibleBuiltInIds: ['enter', 'escape']
      },
      ['builtin:enter', 'builtin:escape']
    )
    expect(
      getTerminalAccessoryEntries(layout, [])
        .filter((entry) => layout.visibleBuiltInIds.includes(entry.key.id))
        .map((entry) => entry.key.id)
    ).toEqual(['enter', 'escape'])
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

  it.each([1, 2])('keeps the prior bar sequence when migrating a v%i layout', (version) => {
    const defaults = getDefaultTerminalAccessoryBuiltInIds()
    const ordered = version === 1 ? defaults : defaults.toReversed()
    const preference = normalizeTerminalAccessoryLayoutPreference({
      version,
      knownBuiltInIds: defaults,
      orderedBuiltInIds: ordered,
      visibleBuiltInIds: ['tab']
    })
    const customKeys = [customKey('second'), customKey('first')]
    const entries = getTerminalAccessoryEntries(preference, customKeys)

    expect(entries.map((entry) => entry.id)).toEqual([
      ...ordered.map((id) => `builtin:${id}`),
      'custom:second',
      'custom:first'
    ])
    expect(
      entries
        .filter(
          (entry) => entry.kind === 'custom' || preference.visibleBuiltInIds.includes(entry.key.id)
        )
        .map((entry) => entry.id)
    ).toEqual(['builtin:tab', 'custom:second', 'custom:first'])
  })

  it('round-trips custom keys before and between built-ins without changing hidden choices', async () => {
    const stored = new Map<string, string>()
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value)
    })
    asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null)
    const customKeys = [customKey('model'), customKey('status')]
    const defaults = getDefaultTerminalAccessoryLayout()
    const order = [
      'custom:status',
      'builtin:tab',
      'custom:model',
      ...defaults.orderedBuiltInIds.filter((id) => id !== 'tab').map((id) => `builtin:${id}`)
    ]
    const layout = setTerminalAccessoryBuiltInVisible(
      reorderTerminalAccessoryIds(defaults, order),
      'escape',
      false
    )

    await saveTerminalAccessoryLayout(layout)
    const reopened = await loadTerminalAccessoryLayout()
    await saveTerminalAccessoryLayout(reopened)
    const reloaded = await loadTerminalAccessoryLayout()

    expect(reloaded).toEqual(reopened)
    expect(reloaded.version).toBe(2)
    expect(reloaded.orderedIds).toEqual(order)
    expect(reloaded.orderedBuiltInIds).toEqual([
      'tab',
      ...defaults.orderedBuiltInIds.filter((id) => id !== 'tab')
    ])
    expect(reloaded.visibleBuiltInIds).not.toContain('escape')
    expect(getTerminalAccessoryEntries(reloaded, customKeys).map((entry) => entry.id)).toEqual(
      order
    )
    expect(
      getTerminalAccessoryEntries(reloaded, customKeys)
        .filter(
          (entry) => entry.kind === 'custom' || reloaded.visibleBuiltInIds.includes(entry.key.id)
        )
        .map((entry) => entry.id)
    ).toEqual(order.filter((id) => id !== 'builtin:escape'))
  })

  it('keeps mixed positions when a built-in is hidden and shown again', () => {
    const current = ['escape', 'tab']
    const layout = reorderTerminalAccessoryIds(
      { orderedBuiltInIds: current, visibleBuiltInIds: current },
      ['custom:model', 'builtin:tab', 'custom:status', 'builtin:escape'],
      current
    )
    const hidden = setTerminalAccessoryBuiltInVisible(layout, 'tab', false, current)
    const shown = setTerminalAccessoryBuiltInVisible(hidden, 'tab', true, current)

    expect(hidden.orderedIds).toEqual(layout.orderedIds)
    expect(hidden.visibleBuiltInIds).toEqual(['escape'])
    expect(shown).toEqual(layout)
    expect(setTerminalAccessoryBuiltInVisible(layout, 'unknown', false, current)).toEqual(layout)
  })

  it('shows custom keys when every built-in is hidden', () => {
    const layout = {
      ...getDefaultTerminalAccessoryLayout(),
      visibleBuiltInIds: [],
      orderedIds: ['custom:model', 'builtin:tab', 'custom:status']
    }
    const entries = getTerminalAccessoryEntries(layout, [customKey('model'), customKey('status')])

    expect(entries.filter((entry) => entry.kind === 'custom').map((entry) => entry.id)).toEqual([
      'custom:model',
      'custom:status'
    ])
    expect(createTerminalAccessoryLayoutPreference(layout).visibleBuiltInIds).toEqual([])
  })

  it('uses separate identities for a custom key whose id matches a built-in', () => {
    const custom = customKey('tab')
    const layout = reorderTerminalAccessoryIds(getDefaultTerminalAccessoryLayout(), [
      'custom:tab',
      ...getDefaultTerminalAccessoryBuiltInIds().map((id) => `builtin:${id}`)
    ])
    const entries = getTerminalAccessoryEntries(layout, [custom])

    expect(entries[0]).toEqual({ id: 'custom:tab', kind: 'custom', key: custom })
    expect(entries.find((entry) => entry.id === 'builtin:tab')).toMatchObject({
      kind: 'builtin',
      key: { id: 'tab', bytes: '\t' }
    })
  })

  it('ignores deleted custom keys and appends new keys without moving survivors', () => {
    const layout = reorderTerminalAccessoryIds(getDefaultTerminalAccessoryLayout(), [
      'custom:second',
      'builtin:tab',
      'custom:deleted',
      'custom:first',
      ...getDefaultTerminalAccessoryBuiltInIds()
        .filter((id) => id !== 'tab')
        .map((id) => `builtin:${id}`)
    ])
    const edited = { ...customKey('second'), label: 'Changed', bytes: 'changed\r' }
    const entries = getTerminalAccessoryEntries(layout, [
      customKey('first'),
      edited,
      customKey('new')
    ])

    expect(entries.slice(0, 3).map((entry) => entry.id)).toEqual([
      'custom:second',
      'builtin:tab',
      'custom:first'
    ])
    expect(entries[0]?.key).toEqual(edited)
    expect(entries.some((entry) => entry.id === 'custom:deleted')).toBe(false)
    expect(entries.at(-1)?.id).toBe('custom:new')
  })

  it('retains saved custom positions while the separate custom-key store is loading', () => {
    const layout = reorderTerminalAccessoryIds(getDefaultTerminalAccessoryLayout(), [
      'custom:model',
      ...getDefaultTerminalAccessoryBuiltInIds().map((id) => `builtin:${id}`)
    ])

    expect(getTerminalAccessoryEntries(layout, []).some((entry) => entry.kind === 'custom')).toBe(
      false
    )
    const persisted = createTerminalAccessoryLayoutPreference(layout)
    expect(persisted.orderedIds?.[0]).toBe('custom:model')
    expect(getTerminalAccessoryEntries(persisted, [customKey('model')])[0]?.id).toBe('custom:model')
  })

  it('sanitizes mixed descriptors and synchronizes built-in ordering', () => {
    const preference = normalizeTerminalAccessoryLayoutPreference(
      {
        version: 2,
        orderedBuiltInIds: ['escape', 'tab'],
        visibleBuiltInIds: ['escape', 'tab'],
        orderedIds: [
          'custom:model',
          'builtin:tab',
          'unknown',
          'builtin:removed',
          'custom:',
          'custom:model',
          'builtin:tab',
          'custom:invalid\u0000id',
          'builtin:escape'
        ]
      },
      ['escape', 'tab']
    )

    expect(preference).toEqual({
      version: 2,
      orderedBuiltInIds: ['tab', 'escape'],
      visibleBuiltInIds: ['tab', 'escape'],
      orderedIds: ['custom:model', 'builtin:tab', 'builtin:escape']
    })
  })

  it.each([null, 'custom:model', ['builtin:tab', 1]])(
    'ignores an invalid optional mixed order without resetting legacy preferences (%j)',
    (orderedIds) => {
      expect(
        normalizeTerminalAccessoryLayoutPreference(
          {
            version: 2,
            orderedBuiltInIds: ['tab', 'escape'],
            visibleBuiltInIds: ['tab'],
            orderedIds
          },
          ['escape', 'tab']
        )
      ).toEqual({
        version: 2,
        orderedBuiltInIds: ['tab', 'escape'],
        visibleBuiltInIds: ['tab']
      })
    }
  )

  it('inserts new built-ins beside their canonical neighbor while preserving custom positions', () => {
    const preference = normalizeTerminalAccessoryLayoutPreference(
      {
        version: 2,
        orderedBuiltInIds: ['enter', 'tab', 'escape'],
        visibleBuiltInIds: ['enter'],
        orderedIds: [
          'custom:model',
          'builtin:enter',
          'builtin:tab',
          'custom:status',
          'builtin:escape'
        ]
      },
      ['escape', 'tab', 'space', 'enter']
    )

    expect(preference.orderedIds).toEqual([
      'custom:model',
      'builtin:enter',
      'builtin:tab',
      'builtin:space',
      'custom:status',
      'builtin:escape'
    ])
    expect(preference.orderedBuiltInIds).toEqual(['enter', 'tab', 'space', 'escape'])
    expect(preference.visibleBuiltInIds).toEqual(['enter', 'space'])
  })

  it('keeps a leading custom key ahead of a newly introduced first built-in', () => {
    const preference = normalizeTerminalAccessoryLayoutPreference(
      {
        version: 2,
        orderedBuiltInIds: ['tab'],
        visibleBuiltInIds: [],
        orderedIds: ['custom:model', 'builtin:tab']
      },
      ['escape', 'tab']
    )

    expect(preference.orderedIds).toEqual(['custom:model', 'builtin:escape', 'builtin:tab'])
    expect(preference.visibleBuiltInIds).toEqual(['escape'])
  })

  it('retains missing built-ins when a stale mixed drag omits one', () => {
    const current = ['escape', 'tab', 'enter']
    const layout = reorderTerminalAccessoryIds(
      {
        orderedBuiltInIds: current,
        visibleBuiltInIds: ['escape', 'enter']
      },
      ['custom:model', 'builtin:enter', 'builtin:escape'],
      current
    )

    expect(layout.orderedIds).toEqual([
      'custom:model',
      'builtin:enter',
      'builtin:escape',
      'builtin:tab'
    ])
    expect(layout.visibleBuiltInIds).toEqual(['enter', 'escape'])
  })

  it('resets built-ins without deleting or scrambling the current custom order', () => {
    const customKeys = [customKey('first'), customKey('second')]
    const layout = reorderTerminalAccessoryIds(
      {
        ...getDefaultTerminalAccessoryLayout(),
        visibleBuiltInIds: []
      },
      [
        'custom:second',
        'builtin:tab',
        'custom:first',
        ...getDefaultTerminalAccessoryBuiltInIds()
          .filter((id) => id !== 'tab')
          .map((id) => `builtin:${id}`)
      ]
    )
    const reset = resetTerminalAccessoryLayout(layout, customKeys)

    expect(reset.orderedBuiltInIds).toEqual(getDefaultTerminalAccessoryBuiltInIds())
    expect(reset.visibleBuiltInIds).toEqual(getDefaultTerminalAccessoryBuiltInIds())
    expect(getTerminalAccessoryEntries(reset, customKeys).map((entry) => entry.id)).toEqual([
      ...getDefaultTerminalAccessoryBuiltInIds().map((id) => `builtin:${id}`),
      'custom:second',
      'custom:first'
    ])
  })

  it('preserves saved custom order when Reset runs before custom-key storage finishes loading', () => {
    const layout = reorderTerminalAccessoryIds(getDefaultTerminalAccessoryLayout(), [
      'custom:second',
      'builtin:tab',
      'custom:first'
    ])
    const reset = resetTerminalAccessoryLayout(layout, [])
    const reopened = normalizeTerminalAccessoryLayoutPreference(
      JSON.parse(JSON.stringify(createTerminalAccessoryLayoutPreference(reset)))
    )
    const lateKeys = [customKey('first'), customKey('second'), customKey('new')]

    expect(getTerminalAccessoryEntries(reopened, lateKeys).map((entry) => entry.id)).toEqual([
      ...getDefaultTerminalAccessoryBuiltInIds().map((id) => `builtin:${id}`),
      'custom:second',
      'custom:first',
      'custom:new'
    ])
  })
})
