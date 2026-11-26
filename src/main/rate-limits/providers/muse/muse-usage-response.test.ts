import { describe, expect, it } from 'vitest'
import { MUSE_NO_USAGE_YET_NOTICE, parseMuseUsageStdout } from './muse-usage-response'

const NOW = 1_795_630_000_000

describe('parseMuseUsageStdout', () => {
  it('reads Muse 1.4.25 reporting no usage yet as an unused five-hour window, not a failure', () => {
    // `muse usage --json` on a subscription with no turn in the current window (2026-11-25).
    const stdout = `${JSON.stringify({
      schemaVersion: 1,
      allowance: null,
      reason: 'server_sent_no_usage',
      hint: 'the server sent no usage data for this subscription; this can happen before your first use in a new window'
    })}\n`
    expect(parseMuseUsageStdout(stdout, NOW)).toEqual({
      kind: 'ok',
      limits: {
        provider: 'muse',
        session: { usedPercent: 0, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: null,
        updatedAt: NOW,
        planType: null,
        error: null,
        notice: MUSE_NO_USAGE_YET_NOTICE,
        status: 'ok',
        usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
      }
    })
  })

  it('keeps an API key or a missing allowance a no-allowance failure', () => {
    for (const reason of ['api_key', 'no_allowance']) {
      const reading = parseMuseUsageStdout(
        JSON.stringify({ schemaVersion: 1, allowance: null, reason }),
        NOW
      )
      expect(reading).toMatchObject({ kind: 'no-allowance', failureKind: 'no-subscription' })
    }
  })
})
