import { describe, expect, it } from 'vitest'
import { AgentHookServer } from './server'

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
  it('reaches the published row', () => {
    const server = new AgentHookServer()
    ingest(server)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      paneKey: PANE_KEY,
      terminalHandle: HANDLE
    })
  })

  it('survives a later write that resolved no handle', () => {
    // Only main's OSC parse resolves one; an HTTP hook post for the same pane carries none and
    // must not erase the row's only join back to its terminal.
    const server = new AgentHookServer()
    ingest(server)
    ingest(server, { terminalHandle: undefined, payload: { state: 'done', prompt: 'ship it' } })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      terminalHandle: HANDLE
    })
  })

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

  it('is never persisted, because it belongs to the runtime that issued it', () => {
    const server = new AgentHookServer()
    ingest(server)
    const serialized = (
      server as unknown as { serializeStatusFile(): string }
    ).serializeStatusFile()
    expect(serialized).toContain(PANE_KEY)
    expect(serialized).not.toContain(HANDLE)
  })
})
