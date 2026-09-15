import { describe, expect, it } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('OMP session status ownership', () => {
  it.each(['omp', 'pi'] as const)(
    'fences child callbacks before they change %s pane metadata',
    async (kind) => {
      const harness = createAgentStatusExtensionHarness({ kind, argv: ['bun', '/opt/omp/bin/omp'] })
      const root = {
        sessionManager: { getSessionId: () => 'root', getSessionFile: () => '/root.jsonl' }
      }
      await harness.callHook('session_start', {}, root)
      await settle()
      harness.fetchMock.mockClear()
      const rootHandlers = { ...harness.handlers }
      harness.reload()
      const child = {
        sessionManager: { getSessionId: () => 'child', getSessionFile: () => '/child.jsonl' }
      }
      for (const name of [
        'session_start',
        'before_agent_start',
        'agent_start',
        'tool_call',
        'tool_execution_start',
        'tool_execution_end',
        'tool_approval_requested',
        'tool_approval_resolved',
        'message_end',
        'agent_end',
        'agent_settled'
      ]) {
        await harness.callHook(
          name,
          { message: { role: 'assistant', content: 'child answer' } },
          child
        )
        await settle()
      }
      expect(harness.fetchMock).not.toHaveBeenCalled()
      await rootHandlers.agent_start({}, root)
      await settle()
      await rootHandlers.agent_end({}, root)
      await settle()
      const bodies = harness.fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))
      expect(bodies.map((body) => body.payload.session_id)).toEqual(['root', 'root'])
      expect(bodies.at(-1).payload.hook_event_name).toBe('agent_end')
    }
  )

  it('preserves a headless owner through reload, new, and resume', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    let sessionId = 'initial'
    const root = {
      hasUI: false,
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => '/session.jsonl' }
    }
    await harness.callHook('session_start', {}, root)
    for (const next of ['initial', 'new', 'resumed']) {
      sessionId = next
      harness.reload()
      await harness.callHook('session_start', { reason: 'reload' }, root)
      await harness.callHook('agent_start', {}, root)
      await settle()
    }
    expect(
      harness.fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).payload.session_id)
    ).toEqual(['initial', 'new', 'resumed'])
  })
  it('uses a distinct ownership key when pane and launch change before callbacks', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const parent = {
      sessionManager: { getSessionId: () => 'parent', getSessionFile: () => '/parent.jsonl' }
    }
    const separate = {
      sessionManager: { getSessionId: () => 'separate', getSessionFile: () => '/separate.jsonl' }
    }
    await harness.callHook('session_start', {}, parent)
    harness.processEnv.ORCA_PANE_KEY = 'pane-2'
    harness.processEnv.ORCA_AGENT_LAUNCH_TOKEN = 'launch-2'
    harness.reload()
    await harness.callHook('agent_start', {}, separate)
    await settle()
    expect(JSON.parse(harness.fetchMock.mock.calls[0][1].body).payload.session_id).toBe('separate')
  })
  it('keeps reporting for legacy callbacks without a session manager', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('agent_start')
    await settle()
    await harness.callHook('agent_end')
    await settle()
    expect(
      harness.fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).payload.hook_event_name)
    ).toEqual(['agent_start', 'agent_end'])
  })
})
