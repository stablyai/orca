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
      fetched: { policy, downloaded: policy, at: NOW - HOUR_MS },
      newestKnown: null,
      now: NOW,
      platform: 'darwin',
      installId: 'install-c',
      ...overrides
    })

  it('enforces only on a fresh download, an allowed platform and inside the cohort', () => {
    const unknownMode = parsed(
      '{"version":1,"revision":4,"kinds":{"rollouts":{"mode":"delete-all"}}}'
    )
    expect(mode()).toBe('enforce')
    expect(mode({ fetched: null })).toBe('report')
    expect(mode({ fetched: { policy, downloaded: policy, at: NOW - 25 * HOUR_MS } })).toBe('report')
    // An older download the cache outranked renews nothing.
    const older = parsed('{"version":1,"revision":2,"kinds":{"rollouts":{"mode":"report"}}}')
    expect(mode({ fetched: { policy, downloaded: older, at: NOW } })).toBe('report')
    expect(mode({ fetched: null, newestKnown: policy })).toBe('report')
    // A newer revision known elsewhere (the cache) outranks this download, even one that reports.
    const newer = parsed('{"version":1,"revision":4,"kinds":{"rollouts":{"mode":"report"}}}')
    expect(mode({ newestKnown: newer })).toBe('report')
    // A failed download keeps a cached kill switch.
    const killed = parsed('{"version":1,"revision":9,"kinds":{"rollouts":{"mode":"off"}}}')
    expect(mode({ fetched: null, newestKnown: killed })).toBe('off')
    // An equal-revision download speaks for itself: its own rule decides, never the cached one.
    for (const rule of ['{"mode":"off"}', '{"mode":"report"}', '{"mode":"enforce"}', '{}']) {
      const same = parsed(`{"version":1,"revision":3,"kinds":{"rollouts":${rule}}}`)
      expect(mode({ fetched: { policy, downloaded: same, at: NOW } })).toBe(
        rule === '{"mode":"off"}' ? 'off' : 'report'
      )
    }
    expect(mode({ installId: 'install-b' })).toBe('report')
    expect(mode({ installId: undefined })).toBe('report')
    expect(mode({ platform: 'win32' })).toBe('report')
    expect(mode({ kind: 'databases' })).toBe('off')
    expect(
      mode({
        fetched: {
          policy: unknownMode,
          downloaded: unknownMode,
          at: NOW
        }
      })
    ).toBe('report')
  })

  it('lets remote thresholds only tighten the reviewed ones', () => {
    const remote = parsed(
      '{"version":1,"revision":5,"kinds":{"databases":{"thresholds":{"minSharedDays":0,"maxSinceLastSharedDays":400,"minSharedPasses":"7"}}}}'
    )
    expect(codexHistoryCleanupThresholds(remote).databases).toEqual({
      minSharedDays: 14,
      minSharedPasses: 5,
      maxSinceLastSharedDays: 30,
      minUnchangedDays: 14
    })
  })
})
