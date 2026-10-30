import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

describe('daemon protocol crossing gate routing', () => {
  it('runs the gate when the protocol constants change', () => {
    expect(classifyPrJobs(['src/main/daemon/daemon-protocol-version.ts'])).toMatchObject({
      should_run: true,
      'cross-version-wire': true,
      package: true,
      package_windows: true
    })
  })

  it.each([
    'config/scripts/daemon-protocol-facts.mjs',
    'config/scripts/check-daemon-protocol-crossing.mjs',
    'config/scripts/stable-release-tags.mjs'
  ])('runs the gate when its checker %s changes', (file) => {
    expect(classifyPrJobs([file])).toMatchObject({ should_run: true, 'cross-version-wire': true })
  })
})
