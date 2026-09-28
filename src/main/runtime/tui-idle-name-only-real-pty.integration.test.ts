import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { runBundledBunFixture } from '../bundled-bun-test-execution'

// Real PTY bytes, foreground reads and elapsed quiescence guard the name-only title regression.
async function runAgentWait(
  mode: 'explicit-idle' | 'quiet',
  workMs: number,
  timeoutMs: number,
  waitForTitle: boolean
) {
  return z
    .object({ satisfied: z.boolean(), elapsedMs: z.number(), transcript: z.string() })
    .parse(
      await runBundledBunFixture(
        join(__dirname, '../daemon/tui-idle-agent-bun-fixture.ts'),
        'runTuiIdleAgentWait',
        { mode, workMs, timeoutMs, waitForTitle },
        timeoutMs + 7_000
      )
    )
}

describe.skipIf(process.platform === 'win32')('tui-idle against a real agent pty', () => {
  it('does not satisfy while the real process streams under a name-only title', async () => {
    const outcome = await runAgentWait('quiet', 60_000, 8_000, true)
    expect(outcome.transcript).toContain('\x1b]0;Codex\x07')
    expect(outcome.satisfied).toBe(false)
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(7_500)
  }, 25_000)

  it('satisfies once the real process emits an explicit idle title', async () => {
    const outcome = await runAgentWait('explicit-idle', 3_000, 20_000, false)
    expect(outcome.satisfied).toBe(true)
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(1_500)
  }, 28_000)

  it('satisfies once the real process goes quiet with the agent still in foreground', async () => {
    const outcome = await runAgentWait('quiet', 3_000, 20_000, false)
    expect(outcome.satisfied).toBe(true)
    // Corroboration is never instant: quiescence must elapse after the last byte.
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(3_000)
  }, 28_000)
})
