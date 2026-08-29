import { describe, expect, it } from 'vitest'
import {
  createHourlyBuildVersion,
  formatHourlyReleaseName,
  nextHourlyBuildNumber
} from './hourly-build-version.mjs'
import { compareAppVersions } from '../../src/shared/app-version'

describe('createHourlyBuildVersion', () => {
  it('stamps the version with a zero-padded UTC timestamp', () => {
    expect(createHourlyBuildVersion('1.4.160', new Date('2026-07-28T04:05:00Z'))).toBe(
      '1.4.160-hourly.202607280405'
    )
  })

  // Why: main's package.json carries the in-flight RC tail. Keeping it would make
  // every hourly semver-NEWER than the RC it was cut from (1.4.160-rc.3-hourly.X >
  // 1.4.160-rc.3), so an ordinary RC-channel check would offer untested hourly
  // builds to RC users. Dropping it parks hourlies below both rc.N and stable,
  // reachable only by an explicit pinned jump.
  it('drops an in-flight rc tail so hourlies never outrank the rc series', () => {
    const version = createHourlyBuildVersion('1.4.160-rc.3', new Date('2026-07-28T14:00:00Z'))
    expect(version).toBe('1.4.160-hourly.202607281400')
    expect(compareAppVersions(version, '1.4.160-rc.3')).toBeLessThan(0)
    expect(compareAppVersions('1.4.160-rc.3-hourly.202607281400', '1.4.160-rc.3')).toBeGreaterThan(
      0
    )
  })

  it('rejects invalid input', () => {
    expect(() => createHourlyBuildVersion('nope', new Date())).toThrow(/valid semver/)
    expect(() => createHourlyBuildVersion('1.4.160', new Date('nope'))).toThrow(/invalid/)
  })
})

describe('formatHourlyReleaseName', () => {
  const name = (iso, buildNumber = 1, commit = 'e698241abcde') =>
    formatHourlyReleaseName('1.4.163-hourly.x', buildNumber, commit, new Date(iso))

  it('renders version, number, Pacific timestamp, and short sha', () => {
    expect(name('2026-07-31T20:54:00Z')).toBe('1.4.163 • 01 • Jul 31, 1:54PM • e698241')
  })

  // Why both sides of DST: the tag's stamp is UTC and the title is Pacific, so
  // the offset between them is not a constant. A test pinned to one season would
  // pass all summer and start failing in November.
  it('follows the Pacific offset across DST', () => {
    expect(name('2026-01-15T02:30:00Z')).toBe('1.4.163 • 01 • Jan 14, 6:30PM • e698241')
    expect(name('2026-07-31T07:00:00Z')).toBe('1.4.163 • 01 • Jul 31, 12:00AM • e698241')
  })

  // Why pinned: 12-hour clocks are where off-by-twelve bugs live, and midnight in
  // particular renders as 0:00 or 24:00 on a formatter set up carelessly.
  it('renders both noon and midnight as 12', () => {
    expect(name('2026-07-31T07:00:00Z')).toContain('12:00AM')
    expect(name('2026-07-31T19:00:00Z')).toContain('12:00PM')
  })

  // Recent ICU puts U+202F before AM/PM; the title must carry no separator at all.
  it('joins the meridiem with no whitespace of any kind', () => {
    expect(name('2026-07-31T20:54:00Z')).toMatch(/\d:\d{2}(AM|PM) •/)
    expect(name('2026-07-31T20:54:00Z')).not.toMatch(/\s[AP]M/u)
  })

  it('pads to two digits and grows past them', () => {
    expect(name('2026-07-31T20:54:00Z', 9)).toContain(' • 09 • ')
    expect(name('2026-07-31T20:54:00Z', 42)).toContain(' • 42 • ')
    expect(name('2026-07-31T20:54:00Z', 1234)).toContain(' • 1234 • ')
  })

  it('rejects a build number that is not a positive integer', () => {
    expect(() => name('2026-07-31T20:54:00Z', 0)).toThrow(/positive integer/)
    expect(() => name('2026-07-31T20:54:00Z', -1)).toThrow(/positive integer/)
    expect(() => name('2026-07-31T20:54:00Z', 1.5)).toThrow(/positive integer/)
    expect(() => name('2026-07-31T20:54:00Z', Number.NaN)).toThrow(/positive integer/)
  })

  it('rejects an invalid timestamp', () => {
    expect(() => formatHourlyReleaseName('1.4.163', 1, 'abcdefg', new Date('nope'))).toThrow(
      /invalid/
    )
  })
})

describe('nextHourlyBuildNumber', () => {
  const titles = [
    '1.4.163 • 01 • Jul 31, 1:54PM • e698241',
    '1.4.163 • 02 • Jul 31, 2:54PM • aaaaaaa',
    '1.4.163 • 37 • Aug 01, 9:00AM • bbbbbbb'
  ]

  it('continues the series for the version being built', () => {
    expect(nextHourlyBuildNumber('1.4.163', titles)).toBe(38)
  })

  // The point of the change: 1.4.164 opens its own series at 01 rather than
  // inheriting 1.4.163's count, which said nothing about 1.4.164.
  it('restarts at 1 when the base version moves', () => {
    expect(nextHourlyBuildNumber('1.4.164', titles)).toBe(1)
    expect(
      nextHourlyBuildNumber('1.4.164', [...titles, '1.4.164 • 01 • Aug 02, 8:00AM • ccccccc'])
    ).toBe(2)
  })

  // Why max and not count: pruning trims to HOURLY_RETAIN_COUNT, so counting
  // would roll backwards and reissue a number already used.
  it('takes the highest number, not the count', () => {
    expect(nextHourlyBuildNumber('1.4.163', ['1.4.163 • 09 • Jul 31, 1:54PM • e698241'])).toBe(10)
  })

  it('starts at 1 with no history at all', () => {
    expect(nextHourlyBuildNumber('1.4.163')).toBe(1)
    expect(nextHourlyBuildNumber('1.4.163', [])).toBe(1)
  })

  // Legacy titles were the raw tag, and a prefix match must not treat 1.4.16 as
  // a prefix of 1.4.163's series.
  it('ignores titles that are not this version', () => {
    expect(nextHourlyBuildNumber('1.4.16', ['1.4.163 • 37 • Aug 01, 9:00AM • bbbbbbb'])).toBe(1)
    expect(nextHourlyBuildNumber('1.4.163', ['v1.4.163-hourly.202607311354', null, ''])).toBe(1)
  })
})
