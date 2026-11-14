import { describe, expect, it } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { wslHookRelayConnectionId } from '../../../../../shared/wsl-hook-relay-contract'

const PANE_KEY = 'tab-handle:33333333-3333-4333-8333-333333333333'
const HANDLE = 'term_identity'

function ingest(server: AgentHookServer, overrides: Record<string, unknown> = {}): void {
  server.ingestTerminalStatus({
    paneKey: PANE_KEY,
    tabId: 'tab-handle',
    worktreeId: 'worktree',
    connectionId: null,
    terminalHandle: HANDLE,
    payload: { state: 'working', prompt: 'ship it', agentType: 'codex' },
    ...overrides
  })
}

describe('the terminal handle a status row is stamped with', () => {
  it('does not cross a connection ownership change on a colliding pane key', () => {
    const server = new AgentHookServer()
    ingest(server, { connectionId: 'ssh-a' })

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-handle',
        worktreeId: 'other-worktree',
        payload: { state: 'done', prompt: 'other host', agentType: 'codex' }
      },
      'ssh-b'
    )

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      connectionId: 'ssh-b',
      worktreeId: 'other-worktree'
    })
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('terminalHandle')
  })

  it('preserves a local WSL terminal join only for its exact relay distro', () => {
    const server = new AgentHookServer()
    const worktreeId = String.raw`repo::\\wsl.localhost\Ubuntu\home\user\repo`
    ingest(server, { worktreeId })

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-handle',
        worktreeId,
        providerSession: { key: 'session_id', id: 'wsl-session' },
        payload: { state: 'working', prompt: 'ship it', agentType: 'codex' }
      },
      wslHookRelayConnectionId('Ubuntu')
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({ terminalHandle: HANDLE })

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-handle',
        worktreeId,
        payload: { state: 'done', prompt: 'wrong distro', agentType: 'codex' }
      },
      wslHookRelayConnectionId('Debian')
    )
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('terminalHandle')
  })
})
