import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexHistoryMoveReport } from './codex-history-move-telemetry'

const telemetry = vi.hoisted(() => ({
  track: vi.fn(() => true),
  isTelemetryEnabled: vi.fn(() => true)
}))
vi.mock('./client', () => telemetry)
vi.mock('../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.4.300' })
}))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-move-telemetry-'))
  telemetry.track.mockClear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function moveReport(homes: string[], wslHomes = 1): CodexHistoryMoveReport {
  return new CodexHistoryMoveReport({
    markerPath: () => join(dir, 'move-status-sent.json'),
    wslHomeCount: () => wslHomes,
    currentHomes: () => homes
  })
}

describe('codex history move telemetry', () => {
  it('reports once every home has a pass, then once more when the counts change', async () => {
    const homes = ['/a', '/b', '/c']
    const first = moveReport(homes)
    first.record('/a', 'moved')
    first.record('/b', 'busy')
    await first.report(homes)
    expect(telemetry.track).not.toHaveBeenCalled()

    first.record('/c', 'no_lock_helper')
    await first.report(homes)
    expect(telemetry.track).toHaveBeenLastCalledWith('codex_history_move_status', {
      platform: process.platform,
      homes: 3,
      moved: 1,
      stuck_busy: 1,
      stuck_no_lock_helper: 1,
      stuck_refused: 0,
      stuck_incomplete: 0,
      stuck_failed: 0,
      wsl_homes: 1
    })

    // Unchanged counts at the next launch send nothing.
    await first.report(homes)
    expect(telemetry.track).toHaveBeenCalledTimes(1)

    first.record('/b', 'moved')
    await first.report(homes)
    expect(telemetry.track).toHaveBeenCalledTimes(2)
    expect(telemetry.track).toHaveBeenLastCalledWith(
      'codex_history_move_status',
      expect.objectContaining({ moved: 2, stuck_busy: 0 })
    )

    // A later run of the same version has used both reports.
    const next = moveReport(['/a'])
    next.record('/a', 'failed')
    await next.report(['/a'])
    expect(telemetry.track).toHaveBeenCalledTimes(2)
  })

  it('holds the follow-up until no home is busy', async () => {
    const homes = ['/a', '/b']
    const report = moveReport(homes)
    report.record('/a', 'busy')
    report.record('/b', 'busy')
    await report.report(homes)
    report.record('/a', 'moved')
    await report.report(homes)
    expect(telemetry.track).toHaveBeenCalledTimes(1)

    report.record('/b', 'moved')
    await report.report(homes)
    expect(telemetry.track).toHaveBeenLastCalledWith(
      'codex_history_move_status',
      expect.objectContaining({ homes: 2, moved: 2, stuck_busy: 0 })
    )
  })

  it('reports an install whose only managed homes are in WSL', async () => {
    await moveReport([], 2).report([])
    expect(telemetry.track).toHaveBeenLastCalledWith(
      'codex_history_move_status',
      expect.objectContaining({ homes: 0, moved: 0, wsl_homes: 2 })
    )
  })
})
