import { describe, expect, it } from 'vitest'
import {
  computeZotzReleaseVersion,
  resolveOrcaBase,
  stableTagsNewestFirst
} from './zotz-release-version.mjs'

describe('computeZotzReleaseVersion', () => {
  it('starts at build 1 and continues after the highest build of the same Orca base', () => {
    expect(computeZotzReleaseVersion('1.4.214', ['v1.4.214', 'desktop-latest'])).toEqual({
      version: '1.4.21401',
      tag: 'v1.4.21401',
      build: 1
    })
    expect(
      computeZotzReleaseVersion('1.4.214', ['v1.4.21401', 'v1.4.21403', 'v1.4.21301'])
    ).toMatchObject({ version: '1.4.21404', build: 4 })
  })

  it('restarts the build count after a sync moves the Orca base', () => {
    expect(computeZotzReleaseVersion('1.4.230', ['v1.4.21427', 'v1.4.259'])).toMatchObject({
      version: '1.4.23001'
    })
  })

  it('refuses a 100th build on the same base', () => {
    expect(() => computeZotzReleaseVersion('1.4.214', ['v1.4.21499'])).toThrow(/sync with Orca/)
  })

  it('refuses a version below one already published', () => {
    expect(() => computeZotzReleaseVersion('1.4.214', ['v1.4.25901'])).toThrow(/not be newer/)
  })
})

describe('Orca base', () => {
  it('orders stable tags numerically and skips prereleases', () => {
    expect(
      stableTagsNewestFirst(['v1.4.99', 'v1.4.262-rc.1', 'v1.4.100', 'desktop-latest', 'v1.5.0'])
    ).toEqual(['v1.5.0', 'v1.4.100', 'v1.4.99'])
  })

  it('uses the newest release whose cut is merged', () => {
    const merged = new Set(['v1.4.259', 'v1.4.258'])
    expect(resolveOrcaBase(['v1.4.262', 'v1.4.259', 'v1.4.258'], (tag) => merged.has(tag))).toBe(
      '1.4.259'
    )
    expect(() => resolveOrcaBase(['v1.4.262'], () => false)).toThrow(/fetch-depth/)
  })
})
