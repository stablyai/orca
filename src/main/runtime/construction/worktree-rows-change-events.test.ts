import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { AgentHookServer } from '../../agent-hooks/server'
import { OrcaRuntimeService } from '../orca-runtime'

describe('worktreeRowsChanged', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tells clients when an agent row changes', () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const server = new AgentHookServer()
    const detach = runtime.attachAgentStatusStore(server)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))

    server.ingestTerminalStatus({
      paneKey: 'tab-1:22222222-2222-4222-8222-222222222222',
      tabId: 'tab-1',
      worktreeId: 'repo-1::/tmp/worktree-a',
      payload: { state: 'working', prompt: 'task', agentType: 'claude' }
    })
    vi.advanceTimersByTime(500)

    expect(events).toContainEqual({ type: 'worktreeRowsChanged' })
    detach()
  })
})
