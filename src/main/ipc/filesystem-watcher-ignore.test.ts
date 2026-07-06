import { afterEach, describe, expect, it } from 'vitest'
import {
  MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT,
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOption
} from './filesystem-watcher-ignore'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('buildParcelWatcherIgnoreOption', () => {
  afterEach(() => {
    setPlatform(realPlatform)
  })

  it('keeps at most 8 plain paths on macOS so FSEventStreamSetExclusionPaths succeeds', () => {
    setPlatform('darwin')
    const option = buildParcelWatcherIgnoreOption(WATCHER_IGNORE_DIRS)
    // @parcel/watcher passes non-glob entries to FSEventStreamSetExclusionPaths,
    // which rejects the WHOLE set past 8 paths — silently disabling daemon-side
    // exclusion of node_modules/.git churn.
    const plainPaths = option.filter((entry) => !entry.includes('*'))
    expect(plainPaths.length).toBeLessThanOrEqual(MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT)
    // Every ignore dir must still be covered, as a path or as a glob.
    for (const dir of WATCHER_IGNORE_DIRS) {
      expect(
        option.some((entry) => entry === dir || entry === `**/${dir}` || entry === `**/${dir}/**`)
      ).toBe(true)
    }
  })

  it('expands to nested globs on Linux/Windows so nested node_modules/.git are excluded', () => {
    for (const platform of ['linux', 'win32'] as const) {
      setPlatform(platform)
      const option = buildParcelWatcherIgnoreOption(WATCHER_IGNORE_DIRS)
      // @parcel/watcher resolves plain names to top-level-only absolute paths on
      // these platforms, so nested dirs must be matched via depth-agnostic globs.
      for (const dir of WATCHER_IGNORE_DIRS) {
        expect(option).toContain(`**/${dir}`)
        expect(option).toContain(`**/${dir}/**`)
      }
      // No plain (glob-free) entries — those would only exclude the top level.
      expect(option.every((entry) => entry.includes('*'))).toBe(true)
    }
  })
})
