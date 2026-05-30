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

describe('terminal accessory layout', () => {
  beforeEach(() => {
    asyncStorageMock.getItem.mockReset()
    asyncStorageMock.setItem.mockReset()
  })

  it('defaults include enter', () => {
    expect(getDefaultTerminalAccessoryBuiltInIds()).toContain('enter')
    expect(getVisibleTerminalAccessoryKeys(getDefaultTerminalAccessoryBuiltInIds())).toContainEqual(
      expect.objectContaining({ id: 'enter', bytes: '\r' })
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
