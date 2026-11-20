import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHookListenerState } from '../../../../shared/agent-hook-listener/listener-state'
import { normalizePiCompatibleEvent } from '../../../../shared/agent-hook-listener/providers/pi-family/pi-family-events'
import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'
import { complete, idle, posts, startAsync } from './agent-status-subagent-event-fixtures'

const reply = { messages: [{ role: 'assistant', stopReason: 'stop' }] }

type Status = { state: string; turnCompletedAt?: number }

function trackStatuses(h: AgentStatusExtensionHarness): () => Status[] {
  const listener = createHookListenerState()
  let seen = 0
  return () => {
    const fresh = posts(h).slice(seen)
    seen += fresh.length
    return fresh.flatMap((payload) => {
      const status = normalizePiCompatibleEvent(
        listener,
        'pi',
        payload.hook_event_name,
        '',
        'pane-1',
        payload
      )
      return status ? [{ state: status.state, turnCompletedAt: status.turnCompletedAt }] : []
    })
  }
}

async function promptStartingWorker(h: AgentStatusExtensionHarness, id: string): Promise<void> {
  await h.callHook('before_agent_start', { messageType: 'user', prompt: 'start a worker' }, idle)
  await h.callHook('agent_start', {}, idle)
  startAsync(h, id, 'worker')
  await h.callHook('agent_end', reply, idle)
  await h.callHook('agent_settled', undefined, idle)
  await vi.advanceTimersByTimeAsync(1_000)
}

describe('Pi reply held only by earlier subagents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('announces the answer to a new prompt once while an earlier subagent still runs', async () => {
    const h = createAgentStatusExtensionHarness({ kind: 'pi' })
    const nextStatuses = trackStatuses(h)

    await promptStartingWorker(h, 'run-1')
    expect(nextStatuses().some((status) => status.turnCompletedAt !== undefined)).toBe(false)

    // Turn 2 answers an unrelated prompt while run-1 still runs.
    await h.callHook('before_agent_start', { messageType: 'user', prompt: 'reply pong' }, idle)
    await h.callHook('agent_start', {}, idle)
    await h.callHook('agent_end', reply, idle)
    await h.callHook('agent_settled', undefined, idle)
    await vi.advanceTimersByTimeAsync(60_000)
    const held = nextStatuses().at(-1)
    expect(held?.state).toBe('working')
    expect(held?.turnCompletedAt).toEqual(expect.any(Number))

    // The all-clear carries the same finish time, so the answer is not announced again.
    complete(h, 'run-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(nextStatuses().at(-1)).toEqual({ state: 'done', turnCompletedAt: held?.turnCompletedAt })
  })

  it('keeps a prompt that starts its own subagent held after that subagent ends', async () => {
    const h = createAgentStatusExtensionHarness({ kind: 'pi' })
    const nextStatuses = trackStatuses(h)

    await promptStartingWorker(h, 'run-1')
    await promptStartingWorker(h, 'run-2')
    complete(h, 'run-2')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(nextStatuses().some((status) => status.turnCompletedAt !== undefined)).toBe(false)

    complete(h, 'run-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(nextStatuses().at(-1)).toEqual({ state: 'done', turnCompletedAt: expect.any(Number) })
  })
})
