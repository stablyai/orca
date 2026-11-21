import { describe, expect, it, vi } from 'vitest'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'

async function busyPiWorker() {
  const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
  let typeKey: (data: string) => unknown = () => undefined
  const ctx: HookContext = {
    ui: {
      onTerminalInput: (handler) => {
        typeKey = handler
        return () => {}
      }
    }
  }
  await harness.callHook('session_start', { reason: 'startup' }, ctx)
  await harness.callHook('agent_start', {}, ctx)
  await harness.callHook('tool_execution_start', { toolName: 'bash', args: {} }, ctx)
  const posted = (): Record<string, unknown>[] =>
    harness.fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).payload)
  await vi.waitFor(() => expect(posted().at(-1)?.hook_event_name).toBe('tool_execution_start'))
  return { harness, ctx, posted, typeKey: (data: string) => typeKey(data) }
}

describe('Pi UI prompt status', () => {
  // Captured 2026-11-20: `/ps` opened over a worker running a 4-minute pytest raised a false
  // "Worker is waiting on a prompt"; Pi stays busy behind its own custom screens.
  it('keeps a worker busy behind a custom screen its person opened', async () => {
    const { harness, ctx, posted, typeKey } = await busyPiWorker()
    typeKey('/ps')
    typeKey('\r')
    await harness.callHook('ui_prompt_start', { reason: 'ui_prompt', kind: 'custom' }, ctx)
    await harness.callHook('tool_execution_end', { toolName: 'bash' }, ctx)
    await vi.waitFor(() => expect(posted().at(-1)?.hook_event_name).toBe('tool_execution_end'))
    expect(posted().map((payload) => payload.hook_event_name)).not.toContain('ui_prompt_start')
    expect(posted().at(-1)?.ui_prompt_active).toBeUndefined()
  })

  it('reports an agent-opened custom dialog after a typed key as waiting', async () => {
    const { harness, ctx, posted, typeKey } = await busyPiWorker()
    typeKey('x')
    // A permission dialog opens from tool_call, after the next call's execution starts.
    await harness.callHook('tool_execution_start', { toolName: 'bash', args: {} }, ctx)
    await harness.callHook('ui_prompt_start', { reason: 'ui_prompt', kind: 'custom' }, ctx)
    await vi.waitFor(() => expect(posted().at(-1)?.hook_event_name).toBe('ui_prompt_start'))
  })
})
