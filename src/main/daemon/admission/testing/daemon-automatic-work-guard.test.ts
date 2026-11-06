import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DaemonAutomaticWorkGuard } from '../daemon-automatic-work-guard'
import { DaemonProcessGrowthMonitor } from '../daemon-process-growth-monitor'

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
