import { describe, expect, it } from 'vitest'
import { computeZotzReleaseVersion } from './zotz-release-version.mjs'

describe('computeZotzReleaseVersion', () => {
  it('starts at build 1 and continues after the highest build of the same Orca base', () => {
    expect(computeZotzReleaseVersion('1.4.214', ['v1.4.214', 'desktop-latest'])).toEqual({
      version: '1.4.21401',
      tag: 'v1.4.21401',
      build: 1
    })
    expect(
      computeZotzReleaseVersion('1.4.214', ['v1.4.21401', 'v1.4.21403', 'v1.4.23001'])
    ).toMatchObject({ version: '1.4.21404', build: 4 })
  })

  it('restarts the build count after a sync moves the Orca base', () => {
    expect(computeZotzReleaseVersion('1.4.230', ['v1.4.21427'])).toMatchObject({
      version: '1.4.23001'
    })
  })

  it('refuses a 100th build on the same base', () => {
    expect(() => computeZotzReleaseVersion('1.4.214', ['v1.4.21499'])).toThrow(/sync with Orca/)
  })
})
