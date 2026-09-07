/**
 * Mid-storm host health samples for forever-freeze detection.
 * Polls `orca status --json` on an interval while a load storm runs.
 */
import { spawn } from 'node:child_process'
import { BoundedLiveFreezeHistory } from './live-freeze-bounded-history.mjs'
import { resolveOrcaCliInvocation } from './live-remote-freeze-rpc.mjs'

/**
 * @param {{ intervalMs?: number, timeoutMs?: number, cliCommand?: string, sampleHistoryLimit?: number, statusSlowMs?: number }} opts
 */
export function startStatusWatchdog(opts = {}) {
  const intervalMs = opts.intervalMs ?? 2000
  const timeoutMs = opts.timeoutMs ?? 30_000
  const cliInvocation = opts.cliCommand
    ? { command: opts.cliCommand, prefixArgs: [] }
    : resolveOrcaCliInvocation()
  const samples = new BoundedLiveFreezeHistory(opts.sampleHistoryLimit ?? 240)
  const statusSlowMs = opts.statusSlowMs ?? 15_000
  let stopped = false
  let inFlight = false
  let infrastructureErrorCount = 0
  let longestUnhealthyWindowMs = 0
  let maxStatusMs = 0
  let runStartMs = null
  let unhealthySampleCount = 0
  const startedAt = performance.now()

  const record = (sample) => {
    samples.add(sample)
    maxStatusMs = Math.max(maxStatusMs, sample.ms || 0)
    if (sample.infrastructureError) {
      infrastructureErrorCount += 1
    }
    const unhealthy =
      !sample.infrastructureError &&
      (Boolean(sample.hang) || sample.ok === false || (sample.ms || 0) >= statusSlowMs)
    if (!unhealthy) {
      runStartMs = null
      return
    }
    unhealthySampleCount += 1
    runStartMs ??= sample.tMs ?? 0
    longestUnhealthyWindowMs = Math.max(
      longestUnhealthyWindowMs,
      (sample.tMs ?? 0) + (sample.ms || 0) - runStartMs
    )
  }

  const summary = () => ({
    sampleCount: samples.totalCount,
    maxStatusMs,
    unhealthySampleCount,
    infrastructureErrorCount,
    longestUnhealthyWindowMs
  })

  const probe = () =>
    new Promise((resolve) => {
      const t0 = performance.now()
      const child = spawn(
        cliInvocation.command,
        [...cliInvocation.prefixArgs, 'status', '--json'],
        {
          env: cliInvocation.env,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let settled = false
      const finish = (result) => {
        if (settled) {
          return
        }
        settled = true
        resolve(result)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({
          tMs: t0 - startedAt,
          ms: performance.now() - t0,
          ok: false,
          hang: true
        })
      }, timeoutMs)
      child.stdout.on('data', () => {})
      child.stderr.on('data', () => {})
      child.on('error', (error) => {
        clearTimeout(timer)
        finish({
          tMs: t0 - startedAt,
          ms: performance.now() - t0,
          ok: false,
          hang: false,
          infrastructureError: true,
          error: String(error)
        })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish({
          tMs: t0 - startedAt,
          ms: performance.now() - t0,
          ok: code === 0,
          hang: false
        })
      })
    })

  const tick = async ({ force = false } = {}) => {
    if ((!force && stopped) || inFlight) {
      return
    }
    inFlight = true
    try {
      const sample = await probe()
      record(sample)
    } finally {
      inFlight = false
    }
  }

  const interval = setInterval(() => {
    void tick()
  }, intervalMs)
  void tick()

  return {
    stop: async () => {
      stopped = true
      clearInterval(interval)
      // Wait for in-flight probe, then force one final sample.
      const deadline = performance.now() + timeoutMs + 1000
      while (inFlight && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      await tick({ force: true })
      return {
        samples: samples.values(),
        ...summary(),
        durationMs: performance.now() - startedAt
      }
    },
    getSamples: () => samples.values(),
    getSummary: summary
  }
}
