import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { stdoutShowsModelTurn } from './antigravity-usage-response'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'

/** Opt in with ORCA_REAL_AGY_CLI_TEST=1: probes the developer's signed-in agy to detect real payload drift. */
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
    expect(result.session ?? result.weekly).not.toBeNull()
  }, 60_000)
})
