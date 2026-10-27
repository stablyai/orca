import { describe, expect, it, vi } from 'vitest'
import {
  readPublishedVersionsFromEnv,
  resolveDevChannelBaseVersion
} from './dev-channel-base-version.mjs'

describe('dev channel base version', () => {
  it('falls back to package.json when no tags are supplied', () => {
    expect(resolveDevChannelBaseVersion('1.4.168-rc.1')).toBe('1.4.168')
    expect(resolveDevChannelBaseVersion('1.4.168', [])).toBe('1.4.168')
  })

  // Stale main RC claimed 1.4.165 after three stable patches had already shipped.
  it('climbs past stables that shipped while main stood still', () => {
    expect(
      resolveDevChannelBaseVersion('1.4.165-rc.0', [
        'v1.4.165',
        'v1.4.166',
        'v1.4.167',
        'v1.4.165-rc.0'
      ])
    ).toBe('1.4.168')
  })

  // Stable 1.4.167 is spent; RC 1.4.168 still targets 1.4.168, not an uncut 1.4.169.
  it('takes the patch above a shipped stable and holds at an open prerelease', () => {
    expect(resolveDevChannelBaseVersion('1.4.167', ['v1.4.167'])).toBe('1.4.168')
    expect(resolveDevChannelBaseVersion('1.4.168-rc.1', ['v1.4.168-rc.1'])).toBe('1.4.168')
  })

  // Recent old-line hotfix must not drag hourly versions backward; take max.
  it('reads the highest tag, not the last one listed', () => {
    expect(resolveDevChannelBaseVersion('1.4.160', ['v1.4.167', 'v1.3.99', 'v1.4.120'])).toBe(
      '1.4.168'
    )
  })

  // Deleted v1.4.202 release once reset hourlies below installed 1.4.203; channel tags retain the floor.
  it('does not drop below an already-published channel version', () => {
    expect(
      resolveDevChannelBaseVersion('1.4.197', [
        'v1.4.201',
        'v1.4.202-hourly.202609141912',
        'v1.4.203-hourly.202609140417'
      ])
    ).toBe('1.4.203')
  })

  it('treats package.json as a floor when it leads the tags', () => {
    expect(resolveDevChannelBaseVersion('1.5.0-rc.0', ['v1.4.167'])).toBe('1.5.0')
  })

  // Legacy unparseable tags must not fail every hourly build.
  it('ignores tags it cannot parse', () => {
    expect(resolveDevChannelBaseVersion('1.4.160', ['nightly', '', 'v1.4.167', 'latest'])).toBe(
      '1.4.168'
    )
  })

  it('rejects a package version that is not semver', () => {
    expect(() => resolveDevChannelBaseVersion('not-a-version')).toThrow(/not valid semver/)
  })

  it('carries major and minor rollovers through the bump', () => {
    expect(resolveDevChannelBaseVersion('1.4.0', ['v2.0.0'])).toBe('2.0.1')
  })

  it('reads whitespace-separated tags from explicit input or the environment', () => {
    expect(readPublishedVersionsFromEnv(' \tv1.4.167\r\nv1.4.166\n')).toEqual([
      'v1.4.167',
      'v1.4.166'
    ])
    expect(readPublishedVersionsFromEnv('')).toEqual([])
    try {
      vi.stubEnv('ORCA_PUBLISHED_VERSIONS', 'v1.4.170\tv1.4.169')
      expect(readPublishedVersionsFromEnv()).toEqual(['v1.4.170', 'v1.4.169'])
      vi.stubEnv('ORCA_PUBLISHED_VERSIONS', undefined)
      expect(readPublishedVersionsFromEnv()).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
