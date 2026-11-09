import { describe, expect, it } from 'vitest'
import type { CloudOomEvent } from '../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedWorkspaceStatus } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import { createOomTracker } from './hosted-workspace-runtime'

function status(checkedAt: number, uptimeSeconds: number, oomKills: number): HostedWorkspaceStatus {
  return {
    state: 'ready',
    metrics: {
      cpuPercent: 1,
      cpus: 4,
      load1: 0,
      memTotalBytes: 8,
      memUsedBytes: 1,
      diskTotalBytes: 8,
      diskUsedBytes: 1,
      uptimeSeconds,
      oomKills,
      lastOomVictim: oomKills ? 'node' : null,
      orcadAlive: true
    },
    uptimeMs: 0,
    usage: { totalMs: 0, centsPerHour: 75, costCents: 0 },
    archive: null,
    checkedAt
  }
}

describe('OOM tracker', () => {
  it('announces each new kill once per boot, despite clock jitter', () => {
    const events: CloudOomEvent[] = []
    const tracker = createOomTracker((event) => events.push(event))
    const t0 = 1_000_000_000
    tracker.observe('ws', 'sbx', status(t0, 100, 1))
    // Same boot, readings straddle a minute boundary: no repeat.
    tracker.observe('ws', 'sbx', status(t0 + 60_400, 160, 1))
    tracker.observe('ws', 'sbx', status(t0 + 120_000, 220, 2))
    expect(events.map((e) => e.oomKills)).toEqual([1, 2])
    expect(events[0]?.victim).toBe('node')
  })

  it('treats a new boot as a fresh counter and forgets stopped sandboxes', () => {
    const events: CloudOomEvent[] = []
    const tracker = createOomTracker((event) => events.push(event))
    tracker.observe('ws', 'sbx', status(1_000_000_000, 100, 1))
    // Restarted: uptime is small again, counter restarts at 1.
    tracker.observe('ws', 'sbx', status(1_000_600_000, 20, 1))
    expect(events).toHaveLength(2)
    tracker.prune(new Set())
    tracker.observe('ws', 'sbx', status(1_000_660_000, 80, 1))
    expect(events).toHaveLength(3)
  })

  it('ignores a status without metrics', () => {
    const events: CloudOomEvent[] = []
    createOomTracker((event) => events.push(event)).observe('ws', 'sbx', {
      ...status(1, 1, 0),
      metrics: null
    })
    expect(events).toEqual([])
  })
})
