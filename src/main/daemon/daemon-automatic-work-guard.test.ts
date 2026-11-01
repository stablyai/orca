import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonAutomaticWorkGuard } from './daemon-automatic-work-guard'
import { DaemonProcessGrowthMonitor } from './daemon-process-growth-monitor'
import type { TerminalSpawnAdmissionMode } from './terminal-spawn-gate'

describe('DaemonAutomaticWorkGuard growth breaker', () => {
  let dir: string
  let rows: { pid: number; ppid: number }[]
  let now: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-growth-'))
    rows = [{ pid: 100, ppid: 1 }]
    now = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function stormUnderOneAgent(mode: TerminalSpawnAdmissionMode) {
    const log = { log: vi.fn() }
    const markerPath = join(dir, 'daemon-v1.automatic-work-run.json')
    let guard: DaemonAutomaticWorkGuard | undefined
    const monitor = new DaemonProcessGrowthMonitor({
      listSessions: () => [{ sessionId: 'agent-session-0001', pid: 100 }],
      recentAutomaticWork: () => true,
      sampleWhenIdle: true,
      onLevelChanged: (level) => guard?.['onPressureChanged'](level),
      onTrip: (trips) => guard?.['onTrip'](trips),
      readRows: async () => rows,
      rootPid: 1,
      now: () => now
    })
    guard = new DaemonAutomaticWorkGuard({
      markerPath,
      mode,
      log,
      listSessions: () => [],
      ownsEndpoint: () => true,
      monitor
    })
    guard.start()
    await monitor.sample()
    for (let step = 1; step <= 3; step++) {
      now = step * 5_000
      for (let i = 0; i < 300; i++) {
        rows.push({ pid: 1_000 * step + i, ppid: 100 })
      }
      await monitor.sample()
    }
    monitor.stop()
    return { guard, monitor, log, markerPath }
  }

  it('pauses automatic work for this run and names the agent whose tree is storming', async () => {
    const { guard, monitor, log, markerPath } = await stormUnderOneAgent('enforce')

    expect(monitor.level).toBe('critical')
    expect(guard['automaticWorkMode']()).toMatchObject({ kind: 'paused', reason: 'pressure' })
    expect(log.log).toHaveBeenCalledWith(
      'process-growth-breaker-tripped',
      expect.objectContaining({
        trips: expect.arrayContaining([expect.objectContaining({ scope: 'session-0001' })])
      })
    )
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ mode: { kind: 'normal' } })
  })

  it('lets the operator clear a pressure pause and reports what it cleared', async () => {
    const { guard } = await stormUnderOneAgent('enforce')
    const wake = vi.spyOn(guard.gate, 'onPressureChanged')

    expect(guard.status()).toMatchObject({
      admission: 'enforce',
      mode: { kind: 'paused', reason: 'pressure' }
    })
    expect(guard.resume()).toMatchObject({
      admission: 'enforce',
      mode: { kind: 'normal' },
      cleared: { kind: 'paused', reason: 'pressure' }
    })
    expect(wake).toHaveBeenCalled()
    expect(guard.resume()).toMatchObject({ cleared: null })
  })

  it('only reports a storm on an observe-only host', async () => {
    const { guard, log } = await stormUnderOneAgent('observe')
    expect(guard['automaticWorkMode']()).toEqual({ kind: 'normal' })
    expect(log.log).toHaveBeenCalledWith('process-growth-breaker-tripped', expect.anything())
  })
})

describe('DaemonAutomaticWorkGuard stop request', () => {
  it('records an outside stop on the marker before teardown, so a cut-short exit is no crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-stop-'))
    try {
      const markerPath = join(dir, 'daemon-v1.automatic-work-run.json')
      const options = {
        markerPath,
        mode: 'enforce' as const,
        log: { log: vi.fn() },
        listSessions: () => [],
        ownsEndpoint: () => true,
        monitor: new DaemonProcessGrowthMonitor({
          listSessions: () => [],
          recentAutomaticWork: () => false,
          sampleWhenIdle: false,
          onLevelChanged: () => {},
          onTrip: () => {},
          readRows: async () => []
        })
      }
      const guard = new DaemonAutomaticWorkGuard(options)
      guard.start()
      guard['marker'].arm()
      expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ state: 'running' })

      guard.recordStopRequested()

      expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ state: 'clean-exit' })
      const next = new DaemonAutomaticWorkGuard(options)
      next.start()
      expect(next.status().mode).toEqual({ kind: 'normal' })
      next.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
