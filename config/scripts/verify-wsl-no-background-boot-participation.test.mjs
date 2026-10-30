import { describe, expect, it } from 'vitest'
import {
  verifyWslNoBackgroundBootParticipation,
  WSL_NO_BACKGROUND_BOOT_TITLES
} from './verify-wsl-no-background-boot-participation.mjs'

function report(runs = 3) {
  return {
    stats: {
      expected: runs * WSL_NO_BACKGROUND_BOOT_TITLES.length,
      skipped: 0,
      unexpected: 0,
      flaky: 0
    },
    suites: [
      {
        specs: WSL_NO_BACKGROUND_BOOT_TITLES.map((title) => ({
          title,
          tests: Array.from({ length: runs }, () => ({
            expectedStatus: 'passed',
            results: [{ status: 'passed' }]
          }))
        }))
      }
    ]
  }
}

describe('WSL E9 guard participation', () => {
  it('accepts both guards executed three times', () => {
    expect(() => verifyWslNoBackgroundBootParticipation(report())).not.toThrow()
  })
  it('rejects a run where the guard skipped', () => {
    const value = report()
    value.stats.skipped = 3
    value.stats.expected = 0
    expect(() => verifyWslNoBackgroundBootParticipation(value)).toThrow('participation failed')
  })
})
