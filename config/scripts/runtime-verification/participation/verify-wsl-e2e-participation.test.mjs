import { describe, expect, it } from 'vitest'
import { verifyWslParticipation, WSL_TEST_TITLES } from './verify-wsl-e2e-participation.mjs'

function report() {
  return {
    stats: { expected: 9, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [
      {
        suites: [
          {
            specs: WSL_TEST_TITLES.map((title) => ({
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

describe('WSL participation', () => {
  it('accepts all three named scenarios executed three times', () => {
    expect(() => verifyWslParticipation(report())).not.toThrow()
  })
  it.each(['skipped', 'unexpected', 'flaky'])('rejects a nonzero %s result', (key) => {
    const value = report()
    value.stats[key] = 1
    expect(() => verifyWslParticipation(value)).toThrow('participation failed')
  })
  it('rejects missing scenarios even when aggregate counts claim nine passes', () => {
    const value = report()
    value.suites[0].suites[0].specs.pop()
    expect(() => verifyWslParticipation(value)).toThrow('requires three executions')
  })
  it('rejects an unrelated scenario substituted for an expected scenario', () => {
    const value = report()
    value.suites[0].suites[0].specs[0].title = 'native shell passes'
    expect(() => verifyWslParticipation(value)).toThrow('Unexpected WSL scenario')
  })
  it('rejects a pass obtained after a failed attempt', () => {
    const value = report()
    value.suites[0].suites[0].specs[0].tests[0].results.unshift({ status: 'failed' })
    expect(() => verifyWslParticipation(value)).toThrow('without retries')
  })
  it('rejects missing report content', () => {
    expect(() => verifyWslParticipation({})).toThrow('participation failed')
  })
})
