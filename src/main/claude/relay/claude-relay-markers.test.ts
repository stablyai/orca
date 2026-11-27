import { describe, expect, it } from 'vitest'
import {
  ProviderRelayOpenWork,
  ProviderRelayWorkReader
} from '../../daemon/provider-relay/provider-relay-work-markers'
import { readProviderRelayDetachPolicy } from '../../daemon/provider-relay/provider-relay-detach-policy'
import { CLAUDE_RELAY_WORK_MARKERS, claudeRelayOpenWork } from './claude-relay-markers'

const line = (frame: Record<string, unknown>) => JSON.stringify({ session_id: 's1', ...frame })

describe('Claude relay work markers', () => {
  it('keep a detached agent busy for its turn and its background tasks, and only then', () => {
    // The daemon accepts these markers as policy (malformed ones would never idle-stop).
    const policy = readProviderRelayDetachPolicy({
      idleStopMs: 60_000,
      markers: CLAUDE_RELAY_WORK_MARKERS.markers,
      open: claudeRelayOpenWork(
        { providerSessionId: 's1', childWork: { live: new Map([['bg-1', {}]]) } },
        true
      )
    })
    expect(policy).not.toBeNull()
    const reader = new ProviderRelayWorkReader(policy!.markers)
    const work = new ProviderRelayOpenWork(policy!.open ?? {})
    const feed = (frame: Record<string, unknown>) => {
      for (const change of reader.read(line(frame))) {
        work.apply(change)
      }
      return work.busy
    }
    expect(work.busy).toBe(true)
    expect(feed({ type: 'result', subtype: 'success' })).toBe(true)
    // An MCP server's or a status line never counts; only the reported task does.
    expect(feed({ type: 'system', subtype: 'status', status: null })).toBe(true)
    expect(feed({ type: 'system', subtype: 'task_notification', task_id: 'bg-1' })).toBe(false)
    expect(feed({ type: 'system', subtype: 'session_state_changed', state: 'running' })).toBe(true)
    expect(feed({ type: 'system', subtype: 'task_started', task_id: 'bg-2' })).toBe(true)
    expect(feed({ type: 'system', subtype: 'session_state_changed', state: 'idle' })).toBe(true)
    expect(
      feed({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'bg-2',
        patch: { status: 'killed' }
      })
    ).toBe(false)
    feed({ type: 'system', subtype: 'task_started', task_id: 'bg-3' })
    expect(feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })).toBe(false)
  })
})
