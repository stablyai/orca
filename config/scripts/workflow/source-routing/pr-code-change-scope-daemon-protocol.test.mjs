import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

describe('daemon protocol crossing gate routing', () => {
  it('runs the gate when the protocol constants change', () => {
    expect(classifyPrJobs(['src/main/daemon/protocol/daemon-protocol-version.ts'])).toMatchObject({
      should_run: true,
      'cross-version-wire': true,
      package: true,
      package_windows: true
    })
  })

  it.each([
    'config/scripts/daemon-protocol/schema-facts/daemon-protocol-facts.mjs',
    'config/scripts/daemon-protocol/admission/check-daemon-protocol-crossing.mjs',
    'config/scripts/release/versioning/stable-release-tags.mjs'
  ])('runs the gate when its checker %s changes', (file) => {
    expect(classifyPrJobs([file])).toMatchObject({ should_run: true, 'cross-version-wire': true })
  })
})
