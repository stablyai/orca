import { describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

function postedHookNames(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => {
    const body: { payload?: { hook_event_name?: unknown } } = JSON.parse(String(call[1]?.body))
    return typeof body.payload?.hook_event_name === 'string' ? body.payload.hook_event_name : ''
  })
}

async function flushPosts(): Promise<void> {
  // Each delivery has a bounded promise chain; no wall-clock sleeps in the harness.
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

function assistantMessage(text: string): { message: Record<string, unknown> } {
  return { message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

/**
 * A sibling extension (the Basic Memory reminder is one) can queue a follow-up run
 * from inside its own `agent_settled` handler. Pi dispatches handlers in registration
 * order and starts the follow-up run synchronously, so this extension sees the NEXT
 * run's `agent_start` before its own `agent_settled` for the run that just ended.
 *
 * Completion belongs to the run that ended, not to a "last run posted" latch: a
 * boolean latch reset on `agent_start` is consumed by the older run's settlement and
 * then swallows the follow-up run's own completion, leaving the host on that run's
 * last working event.
 */
describe('a follow-up run started from another extension settlement', () => {
  it('still reports the follow-up run completion', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    const context = { isIdle: vi.fn(() => true) }

    // First turn establishes that this runtime settles runs.
    await harness.callHook('agent_start', undefined, context)
    await harness.callHook('agent_end', undefined, context)
    await harness.callHook('agent_settled', undefined, context)
    await flushPosts()
    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])

    // Turn 1 ends; a sibling extension's settle handler starts turn 2.
    await harness.callHook('agent_start', undefined, context)
    await harness.callHook('message_end', assistantMessage('all done'), context)
    await harness.callHook('agent_end', undefined, context)
    await harness.callHook('agent_start', undefined, context)
    // Turn 1's settlement reaches this extension only now, after turn 2 started.
    await harness.callHook('agent_settled', undefined, context)
    await harness.callHook('message_end', assistantMessage('nothing durable to save'), context)
    await harness.callHook('agent_end', undefined, context)
    await harness.callHook('agent_settled', undefined, context)
    await flushPosts()

    // The host's last word about the pane must be the follow-up run's completion, not
    // the follow-up's last working frame.
    const posted = postedHookNames(harness.fetchMock)
    expect(posted.at(-1), `posted: ${posted.join(' -> ')}`).toBe('agent_end')
  })
})
