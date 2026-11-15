import type * as NodeOs from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => '/Users/me'
}))

import {
  MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT,
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions,
  macosProtectedWatchExclusions
} from './filesystem-watcher-ignore'

describe('macosProtectedWatchExclusions', () => {
  it('drops all of ~/Library from a home-folder or wider root', () => {
    expect(macosProtectedWatchExclusions('/Users/me', '/Users/me')).toEqual(['/Users/me/Library'])
    expect(macosProtectedWatchExclusions('/Users', '/Users/me')).toEqual(['/Users/me/Library'])
    expect(macosProtectedWatchExclusions('/', '/Users/me')).toEqual(['/Users/me/Library'])
  })

  it("keeps an opened ~/Library but skips other apps' containers", () => {
    expect(macosProtectedWatchExclusions('/Users/me/Library', '/Users/me')).toEqual([
      '/Users/me/Library/Containers',
      '/Users/me/Library/Group Containers'
    ])
  })

  it('excludes nothing for ordinary project roots', () => {
    expect(macosProtectedWatchExclusions('/Users/me/Documents/repo', '/Users/me')).toEqual([])
    expect(
      macosProtectedWatchExclusions('/Users/me/Library/Application Support/orca', '/Users/me')
    ).toEqual([])
    expect(macosProtectedWatchExclusions('/Users/me/Library/Containers', '/Users/me')).toEqual([])
    expect(macosProtectedWatchExclusions('/Users/meow', '/Users/me')).toEqual([])
  })
})

describe('buildParcelWatcherIgnoreOptions on macOS', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('puts the protected path first so the FSEvents cap keeps it', () => {
    const options = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS, '/Users/me')
    expect(options.ignore?.[0]).toBe('/Users/me/Library')
    expect(options.ignore).toHaveLength(MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT)
    expect(options.ignoreGlobs).toHaveLength(1)
  })

  it('leaves project roots and root-less callers unchanged', () => {
    const unchanged = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
    expect(
      buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS, '/Users/me/Documents/repo')
    ).toEqual(unchanged)
    expect(unchanged.ignore).toEqual(
      WATCHER_IGNORE_DIRS.slice(0, MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT)
    )
  })

  it('excludes the protected path even with no directory names', () => {
    expect(buildParcelWatcherIgnoreOptions([], '/Users/me')).toEqual({
      ignore: ['/Users/me/Library']
    })
    expect(buildParcelWatcherIgnoreOptions([], '/Users/me/Documents/repo')).toEqual({})
  })
})
