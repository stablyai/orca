import { describe, expect, it } from 'vitest'
import {
  verifyPackagedBrowserParticipation,
  PACKAGED_BROWSER_TEST_TITLES
} from './verify-packaged-browser-participation.mjs'

function report() {
  return {
    stats: { expected: 6, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [
      {
        suites: [
          {
            specs: PACKAGED_BROWSER_TEST_TITLES.map((title) => ({
              title,
              tests: Array.from({ length: 3 }, () => ({
                expectedStatus: 'passed',
                results: [{ status: 'passed' }]
              }))
            }))
          }
        ]
      }
    ]
  }
}

describe('Packaged browser participation', () => {
  it('accepts both named scenarios executed three times', () => {
    expect(() => verifyPackagedBrowserParticipation(report())).not.toThrow()
  })
  it.each(['skipped', 'unexpected', 'flaky'])('rejects a nonzero %s result', (key) => {
    const value = report()
    value.stats[key] = 1
    expect(() => verifyPackagedBrowserParticipation(value)).toThrow('participation failed')
  })
  it('rejects missing scenarios even when aggregate counts claim six passes', () => {
    const value = report()
    value.suites[0].suites[0].specs.pop()
    expect(() => verifyPackagedBrowserParticipation(value)).toThrow('requires three executions')
  })
  it('rejects an unrelated scenario substituted for an expected scenario', () => {
    const value = report()
    value.suites[0].suites[0].specs[0].title = 'native shell passes'
    expect(() => verifyPackagedBrowserParticipation(value)).toThrow(
      'Unexpected Packaged browser scenario'
    )
  })
  it('rejects a pass obtained after a failed attempt', () => {
    const value = report()
    value.suites[0].suites[0].specs[0].tests[0].results.unshift({ status: 'failed' })
    expect(() => verifyPackagedBrowserParticipation(value)).toThrow('without retries')
  })
  it('rejects missing report content', () => {
    expect(() => verifyPackagedBrowserParticipation({})).toThrow('participation failed')
  })
})
