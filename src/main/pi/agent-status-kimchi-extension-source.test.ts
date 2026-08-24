import { describe, expect, it, vi } from 'vitest'

import { createHarness } from './agent-status-extension-source-test-harness'

describe('getPiAgentStatusExtensionSource — Kimchi', () => {
  it('posts persisted Kimchi session metadata to the Kimchi route', async () => {
    const harness = createHarness({
      kind: 'kimchi',
      existsSync: (path) => path === '/tmp/kimchi-session-1.jsonl'
    })

    await harness.callHook(
      'session_start',
      { reason: 'startup' },
      {
        sessionManager: {
          getSessionId: () => 'kimchi-session-1',
          getSessionFile: () => '/tmp/kimchi-session-1.jsonl'
        }
      }
    )

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4321/hook/kimchi')
    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'session_start',
      session_id: 'kimchi-session-1',
      session_file: '/tmp/kimchi-session-1.jsonl'
    })
  })

  it('waits until Kimchi creates its planned session file before advertising resume identity', async () => {
    let sessionFileExists = false
    const harness = createHarness({
      kind: 'kimchi',
      existsSync: (path) => path === '/tmp/kimchi-session-1.jsonl' && sessionFileExists
    })

    await harness.callHook(
      'session_start',
      { reason: 'startup' },
      {
        sessionManager: {
          getSessionId: () => 'kimchi-session-1',
          getSessionFile: () => '/tmp/kimchi-session-1.jsonl'
        }
      }
    )

    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'session_start'
    })

    sessionFileExists = true
    await harness.callHook('agent_end')

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(String(harness.fetchMock.mock.calls[1]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'agent_end',
      session_id: 'kimchi-session-1',
      session_file: '/tmp/kimchi-session-1.jsonl'
    })
  })

  it('suppresses all Kimchi status posts when KIMCHI_SUBAGENT is set', async () => {
    const harness = createHarness({
      kind: 'kimchi',
      env: { KIMCHI_SUBAGENT: '1' }
    })

    await harness.callHook('session_start', { reason: 'startup' })
    await harness.callHook('agent_start')
    await harness.callHook('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
    })
    await harness.callHook('agent_settled')
    await harness.callHook('agent_end')

    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it('evaluates KIMCHI_SUBAGENT suppression at event time', async () => {
    const harness = createHarness({ kind: 'kimchi' })

    await harness.callHook('agent_start')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))

    harness.processEnv.KIMCHI_SUBAGENT = '1'
    await harness.callHook('agent_end')
    await harness.callHook('tool_call', { toolName: 'read', input: { path: 'one.ts' } })
    await harness.callHook('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] }
    })

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)

    harness.processEnv.KIMCHI_SUBAGENT = undefined
    await harness.callHook('agent_start')
    await harness.callHook('agent_end')

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(3))
  })

  it('does not suppress Kimchi status posts when KIMCHI_SUBAGENT is not 1', async () => {
    const harness = createHarness({
      kind: 'kimchi',
      env: { KIMCHI_SUBAGENT: '0' }
    })

    await harness.callHook('agent_start')
    await harness.callHook('agent_end')

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
  })

  it('does not suppress Pi status posts when KIMCHI_SUBAGENT is set', async () => {
    // Why: KIMCHI_SUBAGENT is kimchi-specific; a leaked value must not silence
    // pi/omp/prime-agent panes.
    const harness = createHarness({
      kind: 'pi',
      env: { KIMCHI_SUBAGENT: '1' }
    })

    await harness.callHook('agent_start')
    await harness.callHook('agent_end')

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
  })
})
