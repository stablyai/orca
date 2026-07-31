import { describe, expect, it } from 'vitest'
import { createHourlyBuildVersion } from './hourly-build-version.mjs'
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
