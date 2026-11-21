import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import { AGENT_CONVERSATION_HANDLERS } from './agent-conversations'

const SESSION_ID = '3540ecf3-47c3-4876-b825-81bf5d6b3595'
const LEAF_ID = '9b2f6a8e-1c3d-4e5f-8a7b-6c5d4e3f2a1b'

function mockClient(places: unknown[]) {
  const client = new RuntimeClient('/tmp/orca-agent-focus-test', 60_000, null, null)
  const call = vi.spyOn(client, 'call').mockImplementation(async (method: string) => ({
    id: 'req-1',
    ok: true as const,
    result:
      method === 'agent.show' ? { orcaSessionId: SESSION_ID, kind: 'chat', places } : { tabs: [] },
    _meta: { runtimeId: 'runtime-1' }
  }))
  return { client, call }
}

function focus(client: RuntimeClient) {
  return AGENT_CONVERSATION_HANDLERS['agent focus']({
    flags: new Map([['id', `orca_session_id:${SESSION_ID}`]]),
    client,
    cwd: '/tmp/worktree',
    json: true
  })
}

describe('agent focus CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("activates the agent's workspace and pane on its host", async () => {
    const { client, call } = mockClient([
      { worktreeId: 'wt-1', workspace: 'feature', paneKey: `tab-7:${LEAF_ID}` }
    ])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await focus(client)

    expect(call).toHaveBeenCalledWith('agent.show', { id: `orca_session_id:${SESSION_ID}` })
    expect(call).toHaveBeenCalledWith('session.tabs.activate', {
      worktree: 'id:wt-1',
      tabId: 'tab-7',
      leafId: LEAF_ID,
      navigation: 'host'
    })
  })

  it('refuses an agent that is not open anywhere', async () => {
    const { client, call } = mockClient([])

    await expect(focus(client)).rejects.toMatchObject({ code: 'agent_not_open' })
    expect(call).not.toHaveBeenCalledWith('session.tabs.activate', expect.anything())
  })
})
