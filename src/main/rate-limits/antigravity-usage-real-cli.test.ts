import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { stdoutShowsModelTurn } from './antigravity-usage-response'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'

/**
 * Runs the real Antigravity CLI against the developer's own signed-in account.
 *
 * Opt in with `ORCA_REAL_AGY_CLI_TEST=1`, the same shape as the real Claude CLI suite. It is off by
 * default because it spawns `agy`, needs a live sign-in, and takes seconds — but it is the only
 * check that catches agy changing the payload the parser is written against.
 *
 * `ORCA_REAL_AGY_CLI_TEST=1 pnpm test src/main/rate-limits/antigravity-usage-real-cli.test.ts`
 */
const enabled = process.env.ORCA_REAL_AGY_CLI_TEST === '1'

describe.skipIf(!enabled)('Antigravity usage against the real agy CLI', () => {
  it('reports quota with at least one named pool', async () => {
    const calls: string[] = []
    const result = await fetchAntigravityRateLimits({
      runCommand: async (spec) => {
        const output = await runProcess(spec)
        calls.push(spec.args?.[0] ?? '')
        if (spec.args?.[0] === '-p') {
          expect(stdoutShowsModelTurn(output.stdout)).toBe(false)
          const envelope: unknown = JSON.parse(output.stdout)
          expect(envelope).toMatchObject({
            conversation_id: '',
            num_turns: 0
          })
        }
        return output
      }
    })
    expect(calls[0]).toBe('--version')

    if (result.status !== 'ok') {
      // A machine with no agy or no sign-in still proves the classification, not a crash.
      expect(result.status).toBe('unavailable')
      expect(result.error).toBeTruthy()
      return
    }

    expect(calls).toEqual(['--version', '-p'])
    expect(result.provider).toBe('antigravity')
    expect(result.error).toBeNull()
    expect(result.buckets?.length).toBeGreaterThan(0)
    expect(result.usageMetadata?.source).toBe('cli')
    for (const bucket of result.buckets ?? []) {
      expect(bucket.name.length).toBeGreaterThan(0)
      expect(bucket.usedPercent).toBeGreaterThanOrEqual(0)
      expect(bucket.usedPercent).toBeLessThanOrEqual(100)
    }
    // At least one window must be summarised, or the segment has nothing to draw.
    expect(result.session ?? result.weekly).not.toBeNull()
  }, 60_000)
})
