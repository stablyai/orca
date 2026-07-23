import type { Dirent } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONFIG_OVERLAY_MAX_ENTRY_NAME_BYTES,
  CONFIG_OVERLAY_MAX_RETAINED_NAME_BYTES,
  CONFIG_OVERLAY_MAX_SOURCE_ENTRIES,
  ConfigOverlayCapacityError,
  ConfigOverlayEntryBudget,
  _configOverlayMirroringInternals
} from './config-overlay-mirroring'

function fileEntry(name: string): Dirent {
  return {
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => false,
    isFIFO: () => false,
    isFile: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false,
    name
  } as unknown as Dirent
}

describe('config overlay entry budget', () => {
  it('accepts the exact entry-count limit and rejects the next streamed entry', () => {
    const budget = new ConfigOverlayEntryBudget()
    for (let index = 0; index < CONFIG_OVERLAY_MAX_SOURCE_ENTRIES; index += 1) {
      budget.reserve('a')
    }

    expect(() => budget.reserve('a')).toThrowError(
      new ConfigOverlayCapacityError(
        'entries',
        CONFIG_OVERLAY_MAX_SOURCE_ENTRIES + 1,
        CONFIG_OVERLAY_MAX_SOURCE_ENTRIES
      )
    )
  })

  it('accepts an exact-limit entry name and rejects one byte more', () => {
    new ConfigOverlayEntryBudget().reserve('a'.repeat(CONFIG_OVERLAY_MAX_ENTRY_NAME_BYTES))

    expect(() =>
      new ConfigOverlayEntryBudget().reserve('a'.repeat(CONFIG_OVERLAY_MAX_ENTRY_NAME_BYTES + 1))
    ).toThrowError(
      new ConfigOverlayCapacityError(
        'entry-name-bytes',
        CONFIG_OVERLAY_MAX_ENTRY_NAME_BYTES + 1,
        CONFIG_OVERLAY_MAX_ENTRY_NAME_BYTES
      )
    )
  })

  it('accepts the exact aggregate encoded-name limit and rejects one more name', () => {
    const budget = new ConfigOverlayEntryBudget()
    const name = 'a'.repeat(4_094)
    expect(Buffer.byteLength(JSON.stringify(name), 'utf8')).toBe(4_096)

    for (let index = 0; index < CONFIG_OVERLAY_MAX_RETAINED_NAME_BYTES / 4_096; index += 1) {
      budget.reserve(name)
    }

    expect(() => budget.reserve('a')).toThrowError(
      new ConfigOverlayCapacityError(
        'retained-name-bytes',
        CONFIG_OVERLAY_MAX_RETAINED_NAME_BYTES + 3,
        CONFIG_OVERLAY_MAX_RETAINED_NAME_BYTES
      )
    )
  })

  it('stops reading immediately after the first over-limit entry', () => {
    const entries = Array.from({ length: 10_000 }, (_, index) => fileEntry(`entry-${index}`))
    let reads = 0
    let visits = 0
    const directory = {
      readSync() {
        reads += 1
        return entries.shift() ?? null
      }
    }

    expect(() =>
      _configOverlayMirroringInternals.scanOpenDirectory(
        directory,
        new ConfigOverlayEntryBudget({ maxEntries: 2 }),
        () => {
          visits += 1
        }
      )
    ).toThrow(ConfigOverlayCapacityError)
    expect(reads).toBe(3)
    expect(visits).toBe(2)
    expect(entries).toHaveLength(9_997)
  })
})
