import { describe, expect, it } from 'vitest'
import { startStatusWatchdog } from './live-remote-status-watchdog.mjs'

describe('startStatusWatchdog', () => {
  it('collects status samples and stops cleanly', async () => {
    // Real path: actually invokes `orca status --json` (must be available in CI/dev with Orca or fail soft).
    const watch = startStatusWatchdog({ intervalMs: 50, timeoutMs: 5_000 })
    await new Promise((r) => setTimeout(r, 180))
    const result = await watch.stop()
    expect(result.samples.length).toBeGreaterThanOrEqual(1)
    expect(result.durationMs).toBeGreaterThan(0)
    for (const s of result.samples) {
      expect(typeof s.ms).toBe('number')
      expect(typeof s.ok).toBe('boolean')
      expect(typeof s.hang).toBe('boolean')
    }
  })

  it('marks CLI spawn failures as infrastructure errors', async () => {
    const watch = startStatusWatchdog({
      intervalMs: 50,
      timeoutMs: 1000,
      cliCommand: 'orca-freeze-watchdog-missing-command'
    })
    const result = await watch.stop()

    expect(result.samples.length).toBeGreaterThanOrEqual(1)
    expect(result.samples.every((sample) => sample.infrastructureError === true)).toBe(true)
    expect(result.samples.every((sample) => sample.hang === false)).toBe(true)
  })

  it('bounds retained samples while preserving full-run counters', async () => {
    const watch = startStatusWatchdog({
      intervalMs: 50,
      timeoutMs: 1000,
      cliCommand: 'orca-freeze-watchdog-missing-command',
      sampleHistoryLimit: 1
    })
    const result = await watch.stop()

    expect(result.samples).toHaveLength(1)
    expect(result.sampleCount).toBeGreaterThan(result.samples.length)
    expect(result.infrastructureErrorCount).toBe(result.sampleCount)
    expect(result.maxStatusMs).toBeGreaterThanOrEqual(0)
  })
})
