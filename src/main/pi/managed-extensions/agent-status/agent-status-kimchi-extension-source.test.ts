import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

describe('Kimchi status extension', () => {
  it('posts persisted session metadata to the Kimchi route', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'kimchi',
      existsSync: (path) => path === '/tmp/kimchi-session.jsonl'
    })

    await harness.callHook(
      'session_start',
      { reason: 'startup' },
      {
        sessionManager: {
          getSessionId: () => 'kimchi-session',
          getSessionFile: () => '/tmp/kimchi-session.jsonl'
        }
      }
    )

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4321/hook/kimchi')
    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toMatchObject({
      hook_event_name: 'session_start',
      session_id: 'kimchi-session',
      session_file: '/tmp/kimchi-session.jsonl'
    })
  })

  it('suppresses Kimchi posts while the harness marks the session as a subagent', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'kimchi',
      env: { KIMCHI_SUBAGENT: '1' }
    })

    await harness.callHook('session_start', { reason: 'startup' })
    await harness.callHook('agent_start')
    await harness.callHook('agent_end')

    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it('evaluates subagent suppression at event time', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'kimchi' })

    await harness.callHook('agent_start')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))

    harness.processEnv.KIMCHI_SUBAGENT = '1'
    await harness.callHook('agent_end')
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)

    harness.processEnv.KIMCHI_SUBAGENT = undefined
    await harness.callHook('agent_start')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
  })

  it('does not apply the Kimchi subagent marker to Pi', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'pi',
      env: { KIMCHI_SUBAGENT: '1' }
    })

    await harness.callHook('agent_start')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
  })
})
