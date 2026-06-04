import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
  createTerminalAccessoryLayoutPreference,
  getDefaultTerminalAccessoryBuiltInIds,
  getVisibleTerminalAccessoryKeys,
  loadTerminalAccessoryLayout,
  normalizeTerminalAccessoryLayoutPreference,
  resetTerminalAccessoryBuiltInIds,
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
  })

  it('returns defaults for corrupt or unreadable storage', async () => {
    asyncStorageMock.getItem.mockResolvedValueOnce('{')
    await expect(loadTerminalAccessoryLayout()).resolves.toEqual(
      createTerminalAccessoryLayoutPreference(getDefaultTerminalAccessoryBuiltInIds())
    )

    asyncStorageMock.getItem.mockRejectedValueOnce(new Error('unreadable'))
    await expect(loadTerminalAccessoryLayout()).resolves.toEqual(
      createTerminalAccessoryLayoutPreference(getDefaultTerminalAccessoryBuiltInIds())
    )
  })

  it('ignores removed ids and de-dupes visible ids', () => {
    expect(
      normalizeTerminalAccessoryLayoutPreference({
        version: 1,
        visibleBuiltInIds: ['escape', 'removed', 'escape', 'tab'],
        knownBuiltInIds: getDefaultTerminalAccessoryBuiltInIds()
      }).visibleBuiltInIds
    ).toEqual(['escape', 'tab'])
  })

  it('appends new defaults only when absent from known ids', () => {
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

  it('keeps Space hidden after that choice is persisted with current known ids', () => {
    const visibleBuiltInIds = getDefaultTerminalAccessoryBuiltInIds().filter((id) => id !== 'space')
    const persisted = createTerminalAccessoryLayoutPreference(visibleBuiltInIds)

    expect(persisted.knownBuiltInIds).toContain('space')
    expect(normalizeTerminalAccessoryLayoutPreference(persisted).visibleBuiltInIds).not.toContain(
      'space'
    )
  })

  it('keeps hidden known defaults hidden, including an all-hidden layout', () => {
    const current = ['escape', 'tab', 'enter']

    expect(
      normalizeTerminalAccessoryLayoutPreference(
        {
          version: 1,
          visibleBuiltInIds: [],
          knownBuiltInIds: current
        },
        current
      ).visibleBuiltInIds
    ).toEqual([])
  })

  it('toggle and reset helpers preserve built-in order', () => {
    expect(setTerminalAccessoryBuiltInVisible(['tab'], 'escape', true, ['escape', 'tab'])).toEqual([
      'escape',
      'tab'
    ])
    expect(
      setTerminalAccessoryBuiltInVisible(['escape', 'tab'], 'escape', false, ['escape', 'tab'])
    ).toEqual(['tab'])
    expect(resetTerminalAccessoryBuiltInIds()).toEqual(getDefaultTerminalAccessoryBuiltInIds())
  })

  it('saves visible ids with current known built-in ids', async () => {
    asyncStorageMock.setItem.mockResolvedValueOnce(undefined)

    await saveTerminalAccessoryLayout(['tab', 'tab', 'missing'])

    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
      JSON.stringify(createTerminalAccessoryLayoutPreference(['tab']))
    )
  })

  it('rejects write failures without mutating helper output', async () => {
    asyncStorageMock.setItem.mockRejectedValueOnce(new Error('nope'))

    await expect(saveTerminalAccessoryLayout(['escape'])).rejects.toThrow('nope')
    expect(createTerminalAccessoryLayoutPreference(['escape']).visibleBuiltInIds).toEqual([
      'escape'
    ])
  })
})
