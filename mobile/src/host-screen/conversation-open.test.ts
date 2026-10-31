import { describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { rpcClientForExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { conversationOpenPane } from './conversation-open'
import type { ConversationRow } from './project-conversations'
import { conversationHistory, conversationWorkspace } from './project-conversations.test-fixture'

function saved(): ConversationRow & { workspace: ReturnType<typeof conversationWorkspace> } {
  const workspace = conversationWorkspace({ hostId: 'runtime:server' })
  return {
    key: 'saved',
    title: 'Saved chat',
    status: 'saved',
    agent: 'codex',
    at: 1,
    workspace,
    history: conversationHistory({
      executionHostId: 'runtime:server',
      structuredSession: { sessionId: 'saved-chat', workspaceId: workspace.worktreeId }
    })
  }
}
const capabilities = [STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY]

describe('opening the selected conversation', () => {
  it('selects an existing pane without restarting an agent', async () => {
    const client = new FakeSession('connected')
    expect(
      await conversationOpenPane({
        row: { ...saved(), paneKey: 'chosen-pane' },
        client,
        capabilities: []
      })
    ).toBe('chosen-pane')
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('reveals a retained record on its owning server through the existing scoped client', async () => {
    const client = new FakeSession('connected')
    const row = saved()
    client.sendRequest.mockResolvedValue({
      id: 'one',
      ok: true,
      result: { ok: true, sessionId: 'saved-chat', workspaceId: row.workspace.worktreeId }
    })
    const scoped = rpcClientForExecutionHost(
      client,
      [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
      row.workspace.hostId
    )
    expect(scoped).not.toBeNull()
    if (!scoped) {
      throw new Error('missing scoped client')
    }
    expect(await conversationOpenPane({ row, client: scoped, capabilities })).toContain(
      'structured-agent-session-saved-chat:'
    )
    expect(client.sendRequest).toHaveBeenCalledWith(
      'agentSession.reveal',
      { sessionId: 'saved-chat' },
      { envelope: { executionHost: 'runtime:server' } }
    )
  })

  it('does not call a missing reveal API on an older host or use a local fallback', async () => {
    const client = new FakeSession('connected')
    await expect(conversationOpenPane({ row: saved(), client, capabilities: [] })).rejects.toThrow(
      'conversation_host_update_required'
    )
    expect(client.sendRequest).not.toHaveBeenCalled()
    expect(rpcClientForExecutionHost(client, [], 'runtime:server')).toBeNull()
  })

  it('refuses a reveal reply for another workspace', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue({
      id: 'one',
      ok: true,
      result: { ok: true, sessionId: 'saved-chat', workspaceId: 'another-workspace' }
    })
    await expect(conversationOpenPane({ row: saved(), client, capabilities })).rejects.toThrow(
      'conversation_host_identity_changed'
    )
  })
})
