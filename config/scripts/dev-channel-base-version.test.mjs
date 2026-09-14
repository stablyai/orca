import { describe, expect, it } from 'vitest'
import {
  readPublishedVersionsFromEnv,
  resolveDevChannelBaseVersion
} from './dev-channel-base-version.mjs'

describe('dev channel base version', () => {
  it('falls back to package.json when no tags are supplied', () => {
    expect(resolveDevChannelBaseVersion('1.4.168-rc.1')).toBe('1.4.168')
    expect(resolveDevChannelBaseVersion('1.4.168', [])).toBe('1.4.168')
  })

  // The bug this exists for: main sat at 1.4.165-rc.0 for twenty hours while three
  // stables shipped, so hourlies claimed a version their users had already passed.
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

  // Why +1 on a stable but not on a prerelease: 1.4.167 is spent, so the next dev
  // build is 1.4.168. But 1.4.168-rc.1 means 1.4.168 is still being built toward,
  // which is what main holds — claiming 1.4.169 would jump a release nobody cut.
  it('takes the patch above a shipped stable and holds at an open prerelease', () => {
    expect(resolveDevChannelBaseVersion('1.4.167', ['v1.4.167'])).toBe('1.4.168')
    expect(resolveDevChannelBaseVersion('1.4.168-rc.1', ['v1.4.168-rc.1'])).toBe('1.4.168')
  })

  // Why max and not most-recent: a hotfix on an old line published today would
  // otherwise drag every subsequent hourly backwards.
  it('reads the highest tag, not the last one listed', () => {
    expect(resolveDevChannelBaseVersion('1.4.160', ['v1.4.167', 'v1.3.99', 'v1.4.120'])).toBe(
      '1.4.168'
    )
  })

  // Why tags rather than GitHub releases: a cut tags before it publishes, and a
  // failed cut can delete the GitHub release while leaving the tag. Releases-only
  // made 1.4.202 vanish from the list while the tag (and any installed 1.4.202)
  // remained, so hourlies sat on 1.4.202-hourly and sorted below that stable.
  it('climbs past a tagged stable that has no GitHub release', () => {
    expect(resolveDevChannelBaseVersion('1.4.197', ['v1.4.201', 'v1.4.202'])).toBe('1.4.203')
  })

  // The 2026-09-14 regression: hourlies had already shipped as 1.4.203, then the
  // main GitHub release list dropped back to v1.4.201. Without the channel tags
  // as a floor, the next hourlies would have been 1.4.202-hourly, which
  // electron-updater will not install over 1.4.203-hourly.
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

  // Why skipped rather than fatal: the main repo carries legacy tags, and one
  // unparseable entry must not fail every hourly build.
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

  it('splits an env tag list on any whitespace', () => {
    expect(readPublishedVersionsFromEnv('v1.4.167\nv1.4.166\n')).toEqual(['v1.4.167', 'v1.4.166'])
    expect(readPublishedVersionsFromEnv('')).toEqual([])
    expect(readPublishedVersionsFromEnv(undefined)).toEqual([])
  })
})
