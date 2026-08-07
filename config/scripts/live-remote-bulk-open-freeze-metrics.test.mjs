import { describe, expect, it } from 'vitest'
import {
  applySwitchTargetCap,
  evaluateFreezeSignals,
  evaluateFullAppFreeze,
  evaluatePermanentLockup,
  evaluateRealisticFreezeSignals,
  extractTerminalHandle,
  humanPaceDelayMs,
  readFreezeNumberEnv,
  REALISTIC_SCENARIOS,
  shouldCapSwitchTargets,
  worktreeSelector
} from './live-remote-bulk-open-freeze-metrics.mjs'

describe('live-remote-bulk-open-freeze-metrics', () => {
  it('extracts term_ handles from nested create payloads', () => {
    expect(extractTerminalHandle({ handle: 'term_abc' })).toBe('term_abc')
    expect(extractTerminalHandle({ terminal: { handle: 'term_nested' } })).toBe('term_nested')
    expect(extractTerminalHandle({ tab: { terminal: 'term_tab' } })).toBe('term_tab')
    expect(extractTerminalHandle({ startupTerminal: { handle: 'term_start' } })).toBe('term_start')
    expect(extractTerminalHandle({ junk: { deep: 'term_deep' } })).toBe('term_deep')
    expect(extractTerminalHandle({ handle: 'not-a-term' })).toBeNull()
    expect(extractTerminalHandle(null)).toBeNull()
  })

  it('builds worktree selectors from id/path', () => {
    expect(
      worktreeSelector({ id: 'repo::C:/Users/neil/orca/orca', path: 'C:/Users/neil/orca/orca' })
    ).toBe('id:repo::C:/Users/neil/orca/orca')
    expect(worktreeSelector({ path: '/tmp/x' })).toBe('path:/tmp/x')
    expect(worktreeSelector({})).toBeNull()
  })

  it('does not cap switch targets when max is 0 (regression for Math.max(2,0) bug)', () => {
    expect(shouldCapSwitchTargets(0)).toBe(false)
    expect(shouldCapSwitchTargets(-1)).toBe(false)
    expect(shouldCapSwitchTargets(2)).toBe(true)
    const many = Array.from({ length: 111 }, (_, i) => `term_${i}`)
    expect(applySwitchTargetCap(many, 0)).toHaveLength(111)
    expect(applySwitchTargetCap(many, 2)).toHaveLength(2)
  })

  it('classifies hard freeze at >=5000ms peak (individual or batch wall)', () => {
    expect(evaluateFreezeSignals({ maxSwitchMs: 3874, maxBatchWallMs: 3874 }).hardFreeze).toBe(
      false
    )
    expect(evaluateFreezeSignals({ maxSwitchMs: 3874, maxBatchWallMs: 3874 }).softFreeze).toBe(true)

    const hardIndividual = evaluateFreezeSignals({ maxSwitchMs: 19954, maxBatchWallMs: 1000 })
    expect(hardIndividual.hardFreeze).toBe(true)
    expect(hardIndividual.peakLatencyMs).toBe(19954)

    const hardBatch = evaluateFreezeSignals({ maxSwitchMs: 900, maxBatchWallMs: 20201 })
    expect(hardBatch.hardFreeze).toBe(true)
    expect(hardBatch.peakLatencyMs).toBe(20201)
  })

  it('evaluates naturalistic peaks without requiring parallel batch amp', () => {
    expect(REALISTIC_SCENARIOS).toContain('idle-backlog-open')
    expect(REALISTIC_SCENARIOS).toContain('idle-backlog-reconnect-open')
    expect(REALISTIC_SCENARIOS).toContain('lockup-storm')
    const soft = evaluateRealisticFreezeSignals({
      maxOpenMs: 3200,
      firstOpenMs: 2800,
      reconnectRefreshMs: 900
    })
    expect(soft.softFreeze).toBe(true)
    expect(soft.hardFreeze).toBe(false)
    expect(soft.peakLatencyMs).toBe(3200)

    const hardFromReconnect = evaluateRealisticFreezeSignals({
      maxOpenMs: 800,
      firstOpenMs: 700,
      reconnectRefreshMs: 6200
    })
    expect(hardFromReconnect.hardFreeze).toBe(true)
    expect(hardFromReconnect.peakLatencyMs).toBe(6200)
  })

  it('flags full-app freeze only for continuous unhealthy status window ≥30s', () => {
    const healthy = evaluateFullAppFreeze({
      statusSamples: [
        { tMs: 0, ms: 150, ok: true },
        { tMs: 2000, ms: 180, ok: true },
        { tMs: 4000, ms: 140, ok: true }
      ],
      foreverWindowMs: 30_000,
      statusSlowMs: 15_000
    })
    expect(healthy.foreverUiLockupObserved).toBe(false)

    const forever = evaluateFullAppFreeze({
      statusSamples: [
        { tMs: 0, ms: 16_000, ok: true },
        { tMs: 16_000, ms: 16_000, ok: true },
        { tMs: 32_000, ms: 16_000, ok: false, hang: true }
      ],
      foreverWindowMs: 30_000,
      statusSlowMs: 15_000
    })
    expect(forever.foreverUiLockupObserved).toBe(true)
    expect(forever.longestUnhealthyWindowMs).toBeGreaterThanOrEqual(30_000)

    expect(
      evaluateFullAppFreeze({ statusSamples: [], killOnlyRecovery: true }).foreverUiLockupObserved
    ).toBe(true)
  })

  it('does not classify watchdog infrastructure errors as an app freeze', () => {
    const result = evaluateFullAppFreeze({
      statusSamples: Array.from({ length: 25 }, (_, index) => ({
        tMs: index * 1500,
        ms: 1,
        ok: false,
        infrastructureError: true,
        error: 'spawn ENOENT'
      }))
    })

    expect(result.foreverUiLockupObserved).toBe(false)
    expect(result.unhealthySampleCount).toBe(0)
    expect(result.infrastructureErrorCount).toBe(25)
  })

  it('preserves full-run watchdog peaks after sample retention rotates', () => {
    const result = evaluateFullAppFreeze({
      statusSamples: [{ tMs: 60_000, ms: 100, ok: true }],
      statusSummary: {
        sampleCount: 40,
        maxStatusMs: 16_000,
        unhealthySampleCount: 3,
        infrastructureErrorCount: 2,
        longestUnhealthyWindowMs: 32_000
      },
      foreverWindowMs: 30_000,
      statusSlowMs: 15_000
    })

    expect(result.foreverUiLockupObserved).toBe(true)
    expect(result.longestUnhealthyWindowMs).toBe(32_000)
    expect(result.maxStatusMs).toBe(16_000)
    expect(result.unhealthySampleCount).toBe(3)
    expect(result.infrastructureErrorCount).toBe(2)
  })

  it('rejects invalid numeric environment values', () => {
    process.env.ORCA_FREEZE_TEST_NUMBER = 'not-a-number'
    expect(() => readFreezeNumberEnv('ORCA_FREEZE_TEST_NUMBER', 5)).toThrow(
      'Invalid ORCA_FREEZE_TEST_NUMBER'
    )
    delete process.env.ORCA_FREEZE_TEST_NUMBER
    expect(readFreezeNumberEnv('ORCA_FREEZE_TEST_NUMBER', 5)).toBe(5)
  })

  it('distinguishes recovered hard stall from permanent lockup', () => {
    // Single reveal timeout with healthy status is NOT permanent app lockup.
    expect(
      evaluatePermanentLockup({
        timedOutOps: 1,
        statusHangMs: 0,
        consecutiveSwitchFailures: 1,
        openFailed: 1,
        openTotal: 64
      }).permanentLockup
    ).toBe(false)
    expect(
      evaluatePermanentLockup({
        timedOutOps: 3,
        statusHangMs: 0,
        consecutiveSwitchFailures: 0,
        openFailed: 3,
        openTotal: 64
      }).permanentLockup
    ).toBe(true)
    expect(
      evaluatePermanentLockup({
        timedOutOps: 0,
        statusHangMs: 60_000,
        consecutiveSwitchFailures: 0,
        permanentTimeoutMs: 60_000
      }).permanentLockup
    ).toBe(true)
    expect(
      evaluatePermanentLockup({
        timedOutOps: 0,
        statusHangMs: 0,
        consecutiveSwitchFailures: 5
      }).permanentLockup
    ).toBe(true)
    expect(
      evaluatePermanentLockup({
        timedOutOps: 0,
        openFailed: 20,
        openTotal: 40
      }).permanentLockup
    ).toBe(true)
  })

  it('human pace delay stays within base+jitter', () => {
    for (let i = 0; i < 20; i += 1) {
      const d = humanPaceDelayMs(250, 150)
      expect(d).toBeGreaterThanOrEqual(250)
      expect(d).toBeLessThanOrEqual(400)
    }
    expect(humanPaceDelayMs(100, 0)).toBe(100)
  })

  it('reads the real hard-freeze lab report when present', async () => {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const reportDir = resolve(process.cwd(), 'test-results/freeze-repro')
    if (!existsSync(reportDir)) {
      // Local clones without lab artifacts still pass pure metrics tests above.
      return
    }
    const reportName = readdirSync(reportDir).find(
      (name) => name.startsWith('live-bulk-open-freeze-') && name.endsWith('.json')
    )
    if (reportName == null) {
      return
    }
    const report = JSON.parse(readFileSync(resolve(reportDir, reportName), 'utf8'))
    const evaluated = evaluateFreezeSignals({
      maxSwitchMs: report.maxSwitchMs,
      maxBatchWallMs: report.maxBatchWallMs ?? 0,
      statusProbeMs: report.statusProbeMs ?? 0,
      memoryProbeMs: report.memoryProbeMs,
      softMs: report.softMs,
      hardMs: report.hardMs
    })
    expect(evaluated.hardFreeze).toBe(report.hardFreeze)
    expect(evaluated.peakLatencyMs).toBeGreaterThanOrEqual(5000)
    expect(typeof report.environment).toBe('string')
    expect(report.environment.length).toBeGreaterThan(0)
    expect(report.switchTargets).toBeGreaterThan(50)
    expect(report.parallel).toBeGreaterThanOrEqual(8)
  })
})
