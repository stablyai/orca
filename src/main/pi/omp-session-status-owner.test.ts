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
      expect(bodies.map((body) => body.payload.session_file)).toEqual([
        '/root.jsonl',
        '/root.jsonl'
      ])
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

  it('uses OMP parent metadata and nested task paths when the root already owns the pane', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const rootFile = '/sessions/root.jsonl'
    const root = {
      sessionManager: {
        getSessionId: () => 'root',
        getSessionFile: () => rootFile,
        getHeader: () => ({ parentSession: undefined })
      }
    }
    await harness.callHook('session_start', {}, root)
    await settle()
    harness.fetchMock.mockClear()
    harness.reload()
    const child = {
      sessionManager: {
        getSessionId: () => 'child',
        getSessionFile: () => '/sessions/root/child.jsonl',
        getHeader: () => ({ parentSession: rootFile })
      }
    }
    await harness.callHook('agent_start', {}, child)
    await settle()
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it('normalizes Windows task transcript paths', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const rootFile = 'C:\\Users\\orca\\root.jsonl'
    const root = {
      sessionManager: {
        getSessionId: () => 'root-win',
        getSessionFile: () => rootFile,
        getHeader: () => ({})
      }
    }
    await harness.callHook('session_start', {}, root)
    harness.reload()
    const child = {
      sessionManager: {
        getSessionId: () => 'child-win',
        getSessionFile: () => 'c:\\users\\orca\\root\\child.jsonl',
        getHeader: () => ({})
      }
    }
    await harness.callHook('agent_start', {}, child)
    await settle()
    expect(harness.fetchMock).not.toHaveBeenCalled()
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

describe('OMP runtime session provenance', () => {
  it.each(['omp', 'pi'] as const)(
    'rejects an earlier child callback before it can claim the %s pane',
    async (kind) => {
      const harness = createAgentStatusExtensionHarness({ kind, argv: ['bun', '/opt/omp/bin/omp'] })
      const child = {
        agentKind: 'sub',
        hasUI: false,
        sessionManager: { getSessionId: () => 'child', getSessionFile: () => '/child.jsonl' }
      }
      await harness.callHook('session_start', {}, child)
      await harness.callHook('agent_start', {}, child)
      await settle()
      expect(harness.fetchMock).not.toHaveBeenCalled()
      harness.reload()
      const root = {
        agentKind: 'main',
        hasUI: false,
        sessionManager: { getSessionId: () => 'root', getSessionFile: () => '/root.jsonl' }
      }
      await harness.callHook('session_start', {}, root)
      await settle()
      harness.fetchMock.mockClear()
      await harness.callHook('agent_start', {}, root)
      await settle()
      expect(harness.fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(harness.fetchMock.mock.calls[0][1].body).payload.session_id).toBe('root')
    }
  )

  it('allows a former child transcript resumed as the runtime main session', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const root = {
      hasUI: false,
      sessionManager: {
        getSessionId: () => 'resumed-child',
        getSessionFile: () => '/sessions/parent/subagent/child.jsonl'
      }
    }
    await harness.callHook('session_start', {}, root)
    await harness.callHook('agent_start', {}, root)
    await settle()
    expect(JSON.parse(harness.fetchMock.mock.calls[0][1].body).payload.session_id).toBe(
      'resumed-child'
    )
  })
})

const payloadsOf = (harness: ReturnType<typeof createAgentStatusExtensionHarness>) =>
  harness.fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).payload)

describe('Pi in-process subagent sessions', () => {
  // Pi caches the extension factory per cwd, so pi-subagents children share module state with the lead.
  it('keeps the lead pane identity and completion while a child session runs', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
    const session = (id: string) => ({
      sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` }
    })
    const lead = session('lead')
    await harness.callHook('session_start', { reason: 'startup' }, lead)
    await harness.callHook('agent_start', {}, lead)
    await settle()
    const leadHandlers = { ...harness.handlers }
    harness.reload()
    const child = {
      sessionManager: {
        ...session('child').sessionManager,
        getHeader: () => ({ parentSession: '/sessions/lead.jsonl' })
      }
    }
    for (const name of ['session_start', 'agent_start', 'message_end', 'agent_end']) {
      await harness.callHook(
        name,
        { reason: 'startup', message: { role: 'assistant', content: 'child done' } },
        child
      )
      await settle()
    }
    await leadHandlers.message_end({ message: { role: 'assistant', content: 'lead done' } }, lead)
    await settle()
    await leadHandlers.agent_end({}, lead)
    await settle()

    const payloads = payloadsOf(harness)
    expect(payloads.map((payload) => payload.session_id).filter(Boolean)).not.toContain('child')
    expect(payloads.at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'lead' })

    harness.reload()
    await harness.callHook(
      'session_start',
      { reason: 'new', previousSessionFile: '/sessions/lead.jsonl' },
      session('next')
    )
    await settle()
    expect(payloadsOf(harness).at(-1)).toMatchObject({
      hook_event_name: 'session_start',
      session_id: 'next'
    })
  })
})
