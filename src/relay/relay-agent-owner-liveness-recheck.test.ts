import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentPresence } from './relay-agent-presence'
import { AGENT_OWNER_RECHECK_INTERVAL_MS } from '../shared/agent-owner-liveness-recheck'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'

function row(paneKey: string, pid?: number, ended?: true): AgentHookEventPayload {
  return {
    paneKey,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    source: 'claude',
    payload: { agentType: 'claude', state: 'working', prompt: 'task' },
    ...(pid === undefined
      ? {}
      : {
          agentPresence: {
            agent: 'claude',
            process: { pid, platform: 'linux', startTime: `boot:${pid}` },
            ...(ended ? { ended } : {})
          }
        })
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('relay recheck of live process owners', () => {
  it('checks only live owners on each beat and stops with the relay', async () => {
    vi.useFakeTimers()
    const rows = [row('pane-live', 4001), row('pane-ownerless'), row('pane-ended', 4002, true)]
    const checkOwner = vi.fn(async () => undefined)
    const presence = new RelayAgentPresence({ rows: () => rows, checkOwner })

    presence.observeHook(rows[0], rows[0], true)
    await vi.advanceTimersByTimeAsync(AGENT_OWNER_RECHECK_INTERVAL_MS * 2)
    expect(checkOwner.mock.calls).toEqual([['pane-live'], ['pane-live']])

    presence.stop()
    await vi.advanceTimersByTimeAsync(AGENT_OWNER_RECHECK_INTERVAL_MS * 3)
    expect(checkOwner).toHaveBeenCalledTimes(2)
  })

  it('stops its timer once no owner is live', async () => {
    vi.useFakeTimers()
    const rows = [row('pane-live', 4001)]
    const checkOwner = vi.fn(async () => undefined)
    const presence = new RelayAgentPresence({ rows: () => rows, checkOwner })
    presence.observeHook(rows[0], rows[0], true)
    rows.length = 0
    await vi.advanceTimersByTimeAsync(AGENT_OWNER_RECHECK_INTERVAL_MS * 3)
    expect(checkOwner).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
