import { describe, expect, it } from 'vitest'
import { noteWakeTimeline } from './cloud-wake-timeline'

describe('cloud wake timeline', () => {
  it('logs one line per wake with the first time each phase was reached', () => {
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    const base = { workspaceId: 'ws', source: 'open' as const, startedAt: 1000 }
    noteWakeTimeline({ ...base, phase: 'waking' }, 1000, log)
    noteWakeTimeline({ ...base, phase: 'connecting' }, 5000, log)
    noteWakeTimeline({ ...base, phase: 'connecting' }, 5100, log)
    expect(lines).toEqual([])
    noteWakeTimeline({ ...base, phase: 'ready' }, 6200, log)
    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'cloud_wake_timeline',
      source: 'open',
      ms: { waking: 0, connecting: 4000, ready: 5200 }
    })
  })

  it('starts over when a newer wake begins before the old one finished', () => {
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    noteWakeTimeline({ workspaceId: 'ws', source: 'open', startedAt: 1, phase: 'waking' }, 1, log)
    noteWakeTimeline(
      { workspaceId: 'ws', source: 'restart', startedAt: 50, phase: 'waking' },
      50,
      log
    )
    noteWakeTimeline(
      { workspaceId: 'ws', source: 'restart', startedAt: 50, phase: 'failed' },
      80,
      log
    )
    expect(JSON.parse(lines[0]!).ms).toEqual({ waking: 0, failed: 30 })
  })
})
