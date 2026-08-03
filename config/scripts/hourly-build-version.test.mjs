import { describe, expect, it } from 'vitest'
import { createHourlyBuildVersion, formatHourlyReleaseName } from './hourly-build-version.mjs'
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
    expect(name('2026-07-31T20:54:00Z')).toBe('1.4.163 • 01 • 07-31 13:54 • e698241')
  })

  // Why both sides of DST: the tag's stamp is UTC and the title is Pacific, so
  // the offset between them is not a constant. A test pinned to one season would
  // pass all summer and start failing in November.
  it('follows the Pacific offset across DST', () => {
    expect(name('2026-01-15T02:30:00Z')).toBe('1.4.163 • 01 • 01-14 18:30 • e698241')
    expect(name('2026-07-31T07:00:00Z')).toBe('1.4.163 • 01 • 07-31 00:00 • e698241')
  })

  // Why: hour12: false renders midnight as "24" on some ICU builds, which would
  // read as an hour that does not exist and sort oddly beside 00:xx.
  it('renders midnight as 00, never 24', () => {
    expect(name('2026-07-31T07:00:00Z')).toContain(' 00:00 ')
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
