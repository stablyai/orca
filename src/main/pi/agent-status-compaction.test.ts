import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'
import { idle, startAsync } from './agent-status-subagent-event-fixtures'

const busy = { isIdle: () => false }

function reply(stopReason: string): { messages: unknown[] } {
  return { messages: [{ role: 'user' }, { role: 'assistant', stopReason }] }
}

// The posts after the run starts, reduced to the fields the host reads for a compaction tail.
function tail(harness: AgentStatusExtensionHarness): Record<string, unknown>[] {
  return harness.fetchMock.mock.calls
    .map((call) => JSON.parse(String(call[1]?.body)).payload)
    .filter((payload) => payload.hook_event_name !== 'agent_start')
    .map(({ hook_event_name, turn_completed_at, is_idle }) => ({
      hook_event_name,
      turn_completed_at,
      is_idle
    }))
}

// Why: the post queue keeps only the latest pending snapshot, and Pi's compaction posts are minutes apart.
async function step(
  harness: AgentStatusExtensionHarness,
  name: string,
  event?: unknown,
  context?: { isIdle: () => boolean; hasPendingMessages?: () => boolean }
): Promise<void> {
  await harness.callHook(name, event, context)
  await vi.advanceTimersByTimeAsync(0)
}

describe('Pi compaction after a finished reply', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stamps a compaction before settle and the settled completion with the reply finish', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await step(harness, 'agent_start')
    await step(harness, 'agent_end', reply('stop'), busy)
    await step(harness, 'session_before_compact', { reason: 'threshold', willRetry: false })
    await step(harness, 'session_compact', {})
    await step(harness, 'agent_settled', undefined, idle)

    const [start, settled] = tail(harness)
    expect(start).toEqual({
      hook_event_name: 'compaction_start',
      turn_completed_at: expect.any(Number)
    })
    expect(settled).toEqual({
      hook_event_name: 'agent_end',
      turn_completed_at: start?.turn_completed_at
    })
  })

  it.each([
    {
      name: 'an overflow retry',
      run: async (harness: AgentStatusExtensionHarness) => {
        await step(harness, 'agent_end', reply('stop'), busy)
        await step(harness, 'session_before_compact', { reason: 'overflow', willRetry: true })
      }
    },
    {
      name: 'an aborted reply',
      run: async (harness: AgentStatusExtensionHarness) => {
        await step(harness, 'agent_end', reply('aborted'), busy)
        await step(harness, 'session_before_compact', { reason: 'threshold', willRetry: false })
      }
    },
    {
      name: 'a reply with queued messages that continue the run',
      run: async (harness: AgentStatusExtensionHarness) => {
        await step(harness, 'agent_end', reply('stop'), busy)
        await step(
          harness,
          'session_before_compact',
          { reason: 'threshold', willRetry: false },
          { isIdle: () => false, hasPendingMessages: () => true }
        )
      }
    },
    {
      name: 'a /compact after the reply settled',
      run: async (harness: AgentStatusExtensionHarness) => {
        await step(harness, 'agent_end', reply('stop'), busy)
        await step(harness, 'agent_settled', undefined, idle)
        await step(harness, 'session_before_compact', { reason: 'manual', willRetry: false })
      }
    },
    {
      name: 'a reply whose children still run',
      run: async (harness: AgentStatusExtensionHarness) => {
        startAsync(harness, 'run-scout', 'scout')
        await step(harness, 'agent_end', reply('stop'), busy)
        await step(harness, 'session_before_compact', { reason: 'threshold', willRetry: false })
      }
    }
  ])('posts no compaction tail for $name', async ({ run }) => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await step(harness, 'agent_start')
    await run(harness)
    await step(harness, 'session_compact', {})

    expect(tail(harness).map((post) => post.hook_event_name)).not.toContain('compaction_start')
  })
})
