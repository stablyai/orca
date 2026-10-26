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

  // RC-tail daily prereleases outrank RC; dropping tail keeps untested daily below RC/stable and reachable only by explicit selection.
  it('drops an in-flight rc tail so dailies never outrank the rc series', () => {
    const version = createDailyBuildVersion('1.4.160-rc.3', new Date('2026-07-28T13:00:00Z'))
    expect(version).toBe('1.4.160-daily.202607281300')
    expect(compareAppVersions(version, '1.4.160-rc.3')).toBeLessThan(0)
  })

  // daily sorts below hourly; neither can outrank RC/stable in routine checks.
  it('sorts below the hourly build of the same base version', () => {
    const version = createDailyBuildVersion('1.4.160', new Date('2026-07-28T13:00:00Z'))
    expect(compareAppVersions(version, '1.4.160-hourly.202607281400')).toBeLessThan(0)
  })

  it('rejects invalid input', () => {
    expect(() => createDailyBuildVersion('nope', new Date())).toThrow(/valid semver/)
    expect(() => createDailyBuildVersion('1.4.160', new Date('nope'))).toThrow(/invalid/)
  })
})

describe('formatDailyReleaseName', () => {
  const name = (iso, buildNumber = 1, commit = 'e698241abcde') =>
    formatDailyReleaseName('1.4.163-daily.x', buildNumber, commit, new Date(iso))

  // Tag is UTC, title Pacific; test both DST offsets to catch seasonal failures.
  it('follows the Pacific offset across DST', () => {
    expect(name('2026-01-15T18:15:00Z')).toBe('1.4.163 • 01 • Jan 15, 10:15AM • e698241')
    expect(name('2026-07-28T17:15:00Z')).toBe('1.4.163 • 01 • Jul 28, 10:15AM • e698241')
  })

  it('rejects a build number that is not a positive integer', () => {
    expect(() => name('2026-07-28T17:15:00Z', 0)).toThrow(/positive integer/)
    expect(() => name('2026-07-28T17:15:00Z', -1)).toThrow(/positive integer/)
    expect(() => name('2026-07-28T17:15:00Z', 1.5)).toThrow(/positive integer/)
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

  // Count rolls backward after retention pruning; max avoids reissuing numbers.
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
