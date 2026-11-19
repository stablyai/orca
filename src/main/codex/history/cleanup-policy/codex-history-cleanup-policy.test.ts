import { describe, expect, it } from 'vitest'
import {
  codexHistoryCleanupThresholds,
  effectiveCodexHistoryCleanupMode,
  parseCodexHistoryCleanupPolicy
} from './codex-history-cleanup-policy'

const NOW = Date.UTC(2026, 10, 17)
const HOUR_MS = 60 * 60 * 1000

function parsed(text: string) {
  const result = parseCodexHistoryCleanupPolicy(text)
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.policy
}

describe('effectiveCodexHistoryCleanupMode', () => {
  // `install-c` hashes to bucket 39 and `install-b` to 493.
  const policy = parsed(
    JSON.stringify({
      version: 1,
      revision: 3,
      kinds: {
        rollouts: { mode: 'enforce', enforcePermille: 40, platforms: ['darwin'] },
        databases: { mode: 'off' }
      },
      future: true
    })
  )
  const mode = (
    overrides: Partial<Parameters<typeof effectiveCodexHistoryCleanupMode>[0]> = {}
  ): string =>
    effectiveCodexHistoryCleanupMode({
      kind: 'rollouts',
      fetched: { policy, at: NOW - HOUR_MS },
      now: NOW,
      platform: 'darwin',
      installId: 'install-c',
      ...overrides
    })

  it('enforces only on a fresh download, an allowed platform and inside the cohort', () => {
    expect(mode()).toBe('enforce')
    expect(mode({ fetched: null })).toBe('report')
    expect(mode({ fetched: { policy, at: NOW - 25 * HOUR_MS } })).toBe('report')
    expect(mode({ installId: 'install-b' })).toBe('report')
    expect(mode({ installId: undefined })).toBe('report')
    expect(mode({ platform: 'win32' })).toBe('report')
    expect(mode({ kind: 'databases' })).toBe('off')
    expect(
      mode({
        fetched: {
          policy: parsed('{"version":1,"revision":4,"kinds":{"rollouts":{"mode":"delete-all"}}}'),
          at: NOW
        }
      })
    ).toBe('report')
  })

  it('clamps remote thresholds and falls back to the defaults', () => {
    const remote = parsed(
      '{"version":1,"revision":5,"kinds":{"databases":{"thresholds":{"minSharedDays":0,"maxSinceLastSharedDays":400,"minSharedPasses":"7"}}}}'
    )
    expect(codexHistoryCleanupThresholds(remote, 'databases')).toEqual({
      minSharedDays: 1,
      minSharedPasses: 5,
      maxSinceLastSharedDays: 90,
      minUnchangedDays: 14
    })
  })
})
