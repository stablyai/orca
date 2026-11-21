import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexHistoryMoveReport } from './codex-history-move-telemetry'

vi.mock('./client', () => ({ track: () => true, isTelemetryEnabled: () => true }))
vi.mock('../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.4.300' })
}))

const dir = mkdtempSync(join(tmpdir(), 'codex-move-telemetry-perf-'))
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Listing the homes runs synchronous file checks on main: an unchanged state must not relist.
it('lists the homes again only after an outcome changes', async () => {
  const currentHomes = vi.fn(() => ['/a'])
  const report = new CodexHistoryMoveReport({
    markerPath: () => join(dir, 'move-status-sent.json'),
    wslHomeCount: () => 0,
    currentHomes
  })
  report.record('/a', 'busy')
  await report.report(['/a'])
  await report.report(['/a'])
  await report.report(['/a'])
  expect(currentHomes).toHaveBeenCalledTimes(1)

  report.record('/a', 'moved')
  await report.report(['/a'])
  expect(currentHomes).toHaveBeenCalledTimes(2)
})
