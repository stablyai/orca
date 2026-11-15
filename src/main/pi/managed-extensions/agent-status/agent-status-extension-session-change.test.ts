import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'
import {
  agentEndCount,
  endTurn,
  postedHookNames,
  posts,
  startAsync
} from './agent-status-subagent-event-fixtures'

// Match Pi 0.87.1/pi-subagents 0.71.0 registration replacement and fresh event buses.
function session(id: string) {
  return {
    isIdle: () => true,
    sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` }
  }
}

function createPi(fetchImpl?: () => Promise<unknown>): AgentStatusExtensionHarness {
  return createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true, fetchImpl })
}

async function holdRunOpen(harness: AgentStatusExtensionHarness, sessionId = 'A'): Promise<void> {
  await harness.callHook('session_start', { reason: 'startup' }, session(sessionId))
  await harness.callHook('agent_start', {}, session(sessionId))
  startAsync(harness, 'run-a', 'scout')
  await endTurn(harness)
}

describe('Pi session changes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries the old session’s completion before sending anything newer', async () => {
    let attempts = 0
    const harness = createPi(async () => {
      attempts += 1
      if (attempts === 3) {
        throw new Error('Orca restarting')
      }
      return { ok: true }
    })
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await vi.advanceTimersByTimeAsync(0)
    // Finish old-session retry before allowing new-session posts to prevent stale final status.
    expect(postedHookNames(harness).at(-1)).toBe('agent_end')
    expect(agentEndCount(harness)).toBe(1)
    await vi.advanceTimersByTimeAsync(250)

    expect(posts(harness).slice(-3)).toMatchObject([
      { hook_event_name: 'agent_end', session_id: 'A' },
      { hook_event_name: 'agent_end', session_id: 'A' },
      { hook_event_name: 'session_start', session_id: 'B' }
    ])
  })
})
