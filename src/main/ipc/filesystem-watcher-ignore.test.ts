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
    for (const dir of WATCHER_IGNORE_DIRS) {
      expect(fallbackRegex.test(dir)).toBe(true)
      expect(fallbackRegex.test(`${dir}/file.ts`)).toBe(true)
      expect(fallbackRegex.test(`packages/app/${dir}`)).toBe(true)
      expect(fallbackRegex.test(`packages/app/${dir}/file.ts`)).toBe(true)
    }
    expect(fallbackRegex.test('packages/app/node_modules-cache/file.ts')).toBe(false)
    expect(fallbackRegex.test('packages/app/.github/workflows/check.yml')).toBe(false)
    expect(fallbackRegex.test('project\\node_modules/file.ts')).toBe(false)
    expect(options.ignoreGlobs?.[0]).not.toContain('?!')
  })

  it('filters nested macOS directories when all names fit in daemon exclusions', () => {
    setPlatform('darwin')
    const options = buildParcelWatcherIgnoreOptions(['node_modules', '.cache'])
    expect(options.ignore).toEqual(['node_modules', '.cache'])
    const regex = new RegExp(options.ignoreGlobs?.[0] ?? '(?!)')
    expect(regex.test('packages/app/node_modules/file.js')).toBe(true)
    expect(regex.test('packages/app/.cache/file.js')).toBe(true)
    expect(regex.test('packages/app/xcache/file.js')).toBe(false)
  })

  it('keeps an empty ignore list empty', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      setPlatform(platform)
      expect(buildParcelWatcherIgnoreOptions([])).toEqual({})
    }
  })

  it('excludes nested worktrees without excluding source paths inside their own watch root', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      setPlatform(platform)
      const options = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
      const regex = new RegExp(options.ignoreGlobs?.[0] ?? '(?!)')
      expect(regex.test('.worktrees/task/src/index.ts')).toBe(true)
      expect(regex.test('packages/app/.worktrees/task/src/index.ts')).toBe(true)
      expect(regex.test('.worktrees\\task\\src\\index.ts')).toBe(platform === 'win32')
      expect(regex.test('src/index.ts')).toBe(false)
      expect(regex.test('.worktrees-backup/src/index.ts')).toBe(false)
    }
  })

  it('matches newline-containing paths only under ignored names', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      setPlatform(platform)
      const options = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
      const regex = new RegExp(options.ignoreGlobs?.[0] ?? '(?!)')
      expect(regex.test('packages/app/node_modules/generated\nnewline.js')).toBe(true)
      expect(regex.test('packages/app/src/source\nnewline.ts')).toBe(false)
      expect(regex.test('packages/app/node_modules-cache/generated\nnewline.js')).toBe(false)
      expect(regex.test('packages\\app\\node_modules\\generated\nnewline.js')).toBe(
        platform === 'win32'
      )
      expect(regex.test('packages\\app\\src\\source\nnewline.ts')).toBe(false)
    }
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
