import { describe, expect, it } from 'vitest'
import {
  CONFIG_OVERLAY_MAX_RETAINED_NAME_BYTES,
  CONFIG_OVERLAY_MAX_SOURCE_ENTRIES,
  ConfigOverlayCapacityError
} from '../pty/config-overlay-mirroring'
import { _configOverlayManifestInternals } from './config-overlay-manifest'

const { parseOverlayManifest } = _configOverlayManifestInternals

describe('OpenCode overlay manifest bounds', () => {
  it('accepts the exact entry limit and rejects one more retained entry', () => {
    const exact = parseOverlayManifest(
      JSON.stringify({
        topLevelEntries: Array.from({ length: CONFIG_OVERLAY_MAX_SOURCE_ENTRIES }, () => 'same'),
        pluginEntries: []
      })
    )
    expect(exact.topLevelEntries).toHaveLength(CONFIG_OVERLAY_MAX_SOURCE_ENTRIES)

    expect(() =>
      parseOverlayManifest(
        JSON.stringify({
          topLevelEntries: Array.from(
            { length: CONFIG_OVERLAY_MAX_SOURCE_ENTRIES + 1 },
            () => 'same'
          ),
          pluginEntries: []
        })
      )
    ).toThrowError(
      new ConfigOverlayCapacityError(
        'entries',
        CONFIG_OVERLAY_MAX_SOURCE_ENTRIES + 1,
        CONFIG_OVERLAY_MAX_SOURCE_ENTRIES
      )
    )
  })

  it('accepts the exact encoded-name budget and rejects the next name', () => {
    const name = 'a'.repeat(4_094)
    const names = Array.from({ length: CONFIG_OVERLAY_MAX_RETAINED_NAME_BYTES / 4_096 }, () => name)
    expect(
      parseOverlayManifest(JSON.stringify({ topLevelEntries: names })).topLevelEntries
    ).toHaveLength(names.length)

    expect(() =>
      parseOverlayManifest(JSON.stringify({ topLevelEntries: [...names, 'a'] }))
    ).toThrowError(
      new ConfigOverlayCapacityError(
        'retained-name-bytes',
        CONFIG_OVERLAY_MAX_RETAINED_NAME_BYTES + 3,
        CONFIG_OVERLAY_MAX_RETAINED_NAME_BYTES
      )
    )
  })

  it('never authorizes cleanup of reserved overlay-owned paths', () => {
    expect(
      parseOverlayManifest(
        JSON.stringify({
          topLevelEntries: ['plugins', '.orca-opencode-overlay-manifest.json', 'auth.json'],
          pluginEntries: ['orca-opencode-status.js', 'user-plugin.js']
        })
      )
    ).toEqual({
      topLevelEntries: ['auth.json'],
      pluginEntries: ['user-plugin.js']
    })
  })
})
