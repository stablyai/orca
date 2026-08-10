import { describe, expect, it } from 'vitest'
import {
  createDailyBuildVersion,
  formatDailyReleaseName,
  nextDailyBuildNumber
} from './daily-build-version.mjs'
import { compareAppVersions } from '../../src/shared/app-version'

describe('createDailyBuildVersion', () => {
  it('stamps the version with a zero-padded UTC timestamp', () => {
    expect(createDailyBuildVersion('1.4.160', new Date('2026-07-28T13:00:00Z'))).toBe(
      '1.4.160-daily.202607281300'
    )
  })

  // Why: main's package.json carries the in-flight RC tail. Keeping it would make
  // every daily semver-NEWER than the RC it was cut from (1.4.160-rc.3-daily.X >
  // 1.4.160-rc.3), so an ordinary RC-channel check would offer untested daily
  // builds to RC users. Dropping it parks dailies below both rc.N and stable,
  // reachable only by an explicit pinned jump.
  it('drops an in-flight rc tail so dailies never outrank the rc series', () => {
    const version = createDailyBuildVersion('1.4.160-rc.3', new Date('2026-07-28T13:00:00Z'))
    expect(version).toBe('1.4.160-daily.202607281300')
    expect(compareAppVersions(version, '1.4.160-rc.3')).toBeLessThan(0)
    expect(compareAppVersions('1.4.160-rc.3-daily.202607281300', '1.4.160-rc.3')).toBeGreaterThan(0)
  })

  // Why: 'daily' sorts before 'hourly' alphabetically, so a daily of the same
  // base never outranks an hourly — both stay below rc/stable and only the
  // channel picker offers them.
  it('sorts below the hourly build of the same base version', () => {
    expect(
      compareAppVersions('1.4.160-daily.202607281300', '1.4.160-hourly.202607281400')
    ).toBeLessThan(0)
  })

  it('rejects invalid input', () => {
    expect(() => createDailyBuildVersion('nope', new Date())).toThrow(/valid semver/)
    expect(() => createDailyBuildVersion('1.4.160', new Date('nope'))).toThrow(/invalid/)
  })
})

describe('formatDailyReleaseName', () => {
  const name = (iso, buildNumber = 1, commit = 'e698241abcde') =>
    formatDailyReleaseName('1.4.163-daily.x', buildNumber, commit, new Date(iso))

  it('renders version, number, Pacific timestamp, and short sha', () => {
    // 13:15 UTC is 6:15AM PDT in July (the daily cut time).
    expect(name('2026-07-28T13:15:00Z')).toBe('1.4.163 • 01 • Jul 28, 6:15AM • e698241')
  })

  // Why both sides of DST: the tag's stamp is UTC and the title is Pacific, so
  // the offset between them is not a constant. A test pinned to one season would
  // pass all summer and start failing in November.
  it('follows the Pacific offset across DST', () => {
    expect(name('2026-01-15T14:15:00Z')).toBe('1.4.163 • 01 • Jan 15, 6:15AM • e698241')
    expect(name('2026-07-28T13:15:00Z')).toBe('1.4.163 • 01 • Jul 28, 6:15AM • e698241')
  })

  it('pads to two digits and grows past them', () => {
    expect(name('2026-07-28T13:15:00Z', 9)).toContain(' • 09 • ')
    expect(name('2026-07-28T13:15:00Z', 42)).toContain(' • 42 • ')
  })

  it('rejects a build number that is not a positive integer', () => {
    expect(() => name('2026-07-28T13:15:00Z', 0)).toThrow(/positive integer/)
    expect(() => name('2026-07-28T13:15:00Z', -1)).toThrow(/positive integer/)
    expect(() => name('2026-07-28T13:15:00Z', 1.5)).toThrow(/positive integer/)
  })

  it('rejects an invalid timestamp', () => {
    expect(() => formatDailyReleaseName('1.4.163', 1, 'abcdefg', new Date('nope'))).toThrow(
      /invalid/
    )
  })
})

describe('nextDailyBuildNumber', () => {
  const titles = [
    '1.4.163 • 01 • Jul 28, 6:00AM • e698241',
    '1.4.163 • 02 • Jul 29, 6:00AM • aaaaaaa',
    '1.4.163 • 09 • Aug 01, 6:00AM • bbbbbbb'
  ]

  it('continues the series for the version being built', () => {
    expect(nextDailyBuildNumber('1.4.163', titles)).toBe(10)
  })

  it('restarts at 1 when the base version moves', () => {
    expect(nextDailyBuildNumber('1.4.164', titles)).toBe(1)
    expect(
      nextDailyBuildNumber('1.4.164', [...titles, '1.4.164 • 01 • Aug 02, 6:00AM • ccccccc'])
    ).toBe(2)
  })

  // Why max and not count: pruning trims to DAILY_RETAIN_COUNT, so counting
  // would roll backwards and reissue a number already used.
  it('takes the highest number, not the count', () => {
    expect(nextDailyBuildNumber('1.4.163', ['1.4.163 • 09 • Jul 31, 6:00AM • e698241'])).toBe(10)
  })

  it('starts at 1 with no history at all', () => {
    expect(nextDailyBuildNumber('1.4.163')).toBe(1)
    expect(nextDailyBuildNumber('1.4.163', [])).toBe(1)
  })

  it('ignores titles that are not this version', () => {
    expect(nextDailyBuildNumber('1.4.16', ['1.4.163 • 09 • Aug 01, 6:00AM • bbbbbbb'])).toBe(1)
    expect(nextDailyBuildNumber('1.4.163', ['v1.4.163-daily.202607311300', null, ''])).toBe(1)
  })
})
