import { afterEach, describe, expect, it } from 'vitest'
import {
  MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT,
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions
} from './filesystem-watcher-ignore'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('buildParcelWatcherIgnoreOptions', () => {
  afterEach(() => {
    setPlatform(realPlatform)
  })

  it('keeps at most 8 plain paths on macOS so FSEventStreamSetExclusionPaths succeeds', () => {
    setPlatform('darwin')
    const options = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
    const option = options.ignore ?? []
    // @parcel/watcher passes non-glob entries to FSEventStreamSetExclusionPaths,
    // which rejects the WHOLE set past 8 paths — silently disabling daemon-side
    // exclusion of node_modules/.git churn.
    const plainPaths = option.filter((entry) => !entry.includes('*'))
    expect(plainPaths.length).toBeLessThanOrEqual(MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT)
    expect(option).toEqual(WATCHER_IGNORE_DIRS.slice(0, MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT))
    const fallbackRegex = new RegExp(options.ignoreGlobs?.[0] ?? '(?!)')
    for (const dir of WATCHER_IGNORE_DIRS.slice(MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT)) {
      expect(fallbackRegex.test(`packages/app/${dir}/file.ts`)).toBe(true)
    }
    expect(options.ignoreGlobs?.[0]).not.toContain('?!')
  })

  it('uses one lookahead-free native regex for nested ignores on Linux/Windows', () => {
    for (const platform of ['linux', 'win32'] as const) {
      setPlatform(platform)
      const options = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
      expect(options.ignore).toBeUndefined()
      expect(options.ignoreGlobs).toHaveLength(1)
      const source = options.ignoreGlobs![0]
      expect(source).not.toContain('?!')
      const regex = new RegExp(source)
      for (const dir of WATCHER_IGNORE_DIRS) {
        expect(regex.test(dir)).toBe(true)
        expect(regex.test(`packages/app/${dir}`)).toBe(true)
        expect(regex.test(`packages\\app\\${dir}\\nested\\file.ts`)).toBe(platform === 'win32')
      }
      expect(regex.test('packages/app/.github/workflows')).toBe(false)
      expect(regex.test('packages/app/node_modules-cache/file.ts')).toBe(false)
      expect(regex.test('project\\node_modules/file.ts')).toBe(platform === 'win32')
    }
  })
})
