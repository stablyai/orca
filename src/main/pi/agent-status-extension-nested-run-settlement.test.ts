import { describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

function postedHookNames(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => {
    const body: { payload?: { hook_event_name?: unknown } } = JSON.parse(String(call[1]?.body))
    return typeof body.payload?.hook_event_name === 'string' ? body.payload.hook_event_name : ''
  })
}

async function flushPosts(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

function assistantMessage(text: string): { message: Record<string, unknown> } {
  return { message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

// Nested settlement can start the next run first; completion tracking must remain per-run rather than one resettable latch.
describe('a follow-up run started from another extension settlement', () => {
  it('still reports the follow-up run completion', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    const context = { isIdle: vi.fn(() => true) }

    await harness.callHook('agent_start', undefined, context)
    await harness.callHook('agent_end', undefined, context)
    await harness.callHook('agent_settled', undefined, context)
    await flushPosts()
    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])

    await harness.callHook('agent_start', undefined, context)
    await harness.callHook('message_end', assistantMessage('all done'), context)
    await harness.callHook('agent_end', undefined, context)
    await harness.callHook('agent_start', undefined, context)
    await harness.callHook('agent_settled', undefined, context)
    await harness.callHook('message_end', assistantMessage('nothing durable to save'), context)
    await harness.callHook('agent_end', undefined, context)
    await harness.callHook('agent_settled', undefined, context)
    await flushPosts()

    const posted = postedHookNames(harness.fetchMock)
    expect(posted.at(-1), `posted: ${posted.join(' -> ')}`).toBe('agent_end')
  })
})
