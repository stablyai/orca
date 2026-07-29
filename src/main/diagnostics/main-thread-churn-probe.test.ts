import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAIN_THREAD_DIAGNOSTICS_ENV,
  classifySubprocessCommand,
  drainSubprocessSpawnStats,
  isMainThreadDiagnosticsEnabled,
  recordSubprocessSpawn,
  startMainThreadChurnProbe
} from './main-thread-churn-probe'
import { writeStartupDiagnosticLine } from '../startup/startup-diagnostics'

vi.mock('../startup/startup-diagnostics', () => ({
  writeStartupDiagnosticLine: vi.fn()
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(writeStartupDiagnosticLine).mockClear()
  drainSubprocessSpawnStats()
})

describe('classifySubprocessCommand', () => {
  it('uses the git subcommand, skipping global value flags', () => {
    expect(classifySubprocessCommand('git', ['-C', '/repo', 'status', '--porcelain=v2'])).toBe(
      'git status'
    )
    expect(
      classifySubprocessCommand('git', ['-c', 'core.quotepath=off', 'rev-list', '--count'])
    ).toBe('git rev-list')
    expect(classifySubprocessCommand('git', ['--git-dir=/repo/.git', 'log', '--oneline'])).toBe(
      'git log'
    )
  })

  it('normalizes absolute paths and .exe suffixes', () => {
    expect(classifySubprocessCommand('/usr/bin/git', ['status'])).toBe('git status')
    expect(classifySubprocessCommand('C:\\Program Files\\Git\\git.exe', ['fetch'])).toBe(
      'git fetch'
    )
    expect(classifySubprocessCommand('gh', ['api', 'rate_limit'])).toBe('gh api')
  })

  it('unwraps wsl.exe-routed commands', () => {
    expect(
      classifySubprocessCommand('wsl.exe', ['-d', 'Ubuntu', '--', 'git', 'status', '--porcelain'])
    ).toBe('git status')
    expect(classifySubprocessCommand('wsl.exe', ['-d', 'Ubuntu'])).toBe('wsl')
  })

  it('falls back to the binary name when no subcommand exists', () => {
    expect(classifySubprocessCommand('rg', ['--files'])).toBe('rg')
  })

  it('never treats positionals or git-flag values as subcommands for non-subcommand CLIs', () => {
    // rg's -C takes a number; it must not be consumed as a git-style flag
    // value, and "3"/"pattern" must not become fake subcommand buckets.
    expect(classifySubprocessCommand('rg', ['-C', '3', 'pattern'])).toBe('rg')
    expect(classifySubprocessCommand('node', ['script.js'])).toBe('node')
  })
})

describe('startMainThreadChurnProbe stall spans', () => {
  const TICK_MS = 25
  const REPORT_EVERY_MS = 5_000

  /**
   * Drives the probe's interval with a scripted performance.now() so a stall of
   * a known length can be asserted. Returns the stalls from the emitted report.
   */
  function runProbeWithStall(stallMs: number): { fromMs: number; toMs: number; gapMs: number }[] {
    vi.stubEnv(MAIN_THREAD_DIAGNOSTICS_ENV, '1')
    vi.useFakeTimers()
    // Tick 0 sets the baseline; tick 1 lands `stallMs` late; the rest are
    // on time until the 5s report boundary is crossed.
    let clock = 0
    let tick = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)

    startMainThreadChurnProbe()
    while (clock < REPORT_EVERY_MS + TICK_MS) {
      clock += tick === 1 ? TICK_MS + stallMs : TICK_MS
      tick++
      vi.advanceTimersByTime(TICK_MS)
    }

    const lines = vi.mocked(writeStartupDiagnosticLine).mock.calls.map(([line]) => line)
    const report = lines.find((line) => line.startsWith('[main-thread] '))
    expect(report, 'probe emitted no report').toBeDefined()
    return JSON.parse(report!.slice('[main-thread] '.length)).stalls
  }

  // Why: gapMs subtracts one nominal tick, so anchoring fromMs at the previous
  // callback reported a span 25ms wider than the stall it names and pointed at
  // a moment the main thread was still responsive — which misattributes the
  // stall to whichever startup milestone happens to sit in that window.
  it('reports a span whose width equals the gap it names', () => {
    const stalls = runProbeWithStall(1_000)
    expect(stalls).toHaveLength(1)
    expect(stalls[0].gapMs).toBe(1_000)
    expect(stalls[0].toMs - stalls[0].fromMs).toBe(stalls[0].gapMs)
  })

  it('ignores a gap under the 250ms threshold', () => {
    expect(runProbeWithStall(100)).toEqual([])
  })
})

describe('recordSubprocessSpawn', () => {
  it('is a no-op when the diagnostics env var is unset', () => {
    vi.stubEnv(MAIN_THREAD_DIAGNOSTICS_ENV, '')
    expect(isMainThreadDiagnosticsEnabled()).toBe(false)
    recordSubprocessSpawn('git', ['status'], 1)
    expect(drainSubprocessSpawnStats()).toEqual({})
  })

  it('aggregates count and block time per command, and drain resets', () => {
    vi.stubEnv(MAIN_THREAD_DIAGNOSTICS_ENV, '1')
    recordSubprocessSpawn('git', ['-C', '/repo', 'status'], 2)
    recordSubprocessSpawn('/usr/bin/git', ['status', '--porcelain=v2'], 4)
    recordSubprocessSpawn('git', ['rev-list', '--count'], 1.5)
    expect(drainSubprocessSpawnStats()).toEqual({
      'git status': { count: 2, blockMsTotal: 6, blockMsMax: 4 },
      'git rev-list': { count: 1, blockMsTotal: 1.5, blockMsMax: 1.5 }
    })
    expect(drainSubprocessSpawnStats()).toEqual({})
  })
})
