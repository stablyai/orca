import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { selectFreshExplicitAgentStatus } from '../runtime/runtime-hook-agent-row-selection'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'

const PANE_KEY = 'tab-handle:33333333-3333-4333-8333-333333333333'
const HANDLE = 'term_identity'
const NEW_PANE_KEY = 'tab-reminted:44444444-4444-4444-8444-444444444444'

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

  it('moves one PTY row and all of its resume identity across a pane remint', () => {
    const server = new AgentHookServer()
    ingest(server)
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-handle',
        worktreeId: 'worktree',
        providerSession: { key: 'session_id', id: 'session-1' },
        payload: { state: 'working', prompt: 'ship it', agentType: 'codex' }
      },
      null
    )
    const mutations: Parameters<Parameters<typeof server.subscribeStatusRowMutations>[0]>[0][] = []
    server.subscribeStatusRowMutations((mutation) => mutations.push(mutation))

    ingest(server, { paneKey: NEW_PANE_KEY, tabId: 'tab-reminted' })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: NEW_PANE_KEY,
        terminalHandle: HANDLE,
        providerSession: { key: 'session_id', id: 'session-1' }
      })
    ])
    expect(mutations).toEqual([
      {
        before: { paneKey: PANE_KEY, worktreeId: 'worktree', terminalHandle: HANDLE },
        after: { paneKey: NEW_PANE_KEY, worktreeId: 'worktree', terminalHandle: HANDLE }
      }
    ])

    server.dropStatusEntry(NEW_PANE_KEY)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: NEW_PANE_KEY,
        providerSessionOnly: true,
        providerSession: { key: 'session_id', id: 'session-1' }
      })
    ])
    expect(server.reconcileEndedProcessForPaneKeys([NEW_PANE_KEY])).toBe(1)
    expect(server.getStatusSnapshot()).toEqual([])
    expect(mutations).toHaveLength(3)
    expect(
      (server as unknown as { paneKeyByTerminalHandle: Map<string, string> })
        .paneKeyByTerminalHandle
    ).toEqual(new Map())
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

  it('renews duplicate OSC evidence without publishing another semantic row', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const enriched = vi.fn()
      const mutated = vi.fn()
      const statusChanges = vi.fn()
      server.subscribeEnrichedStatus(enriched)
      server.subscribeStatusRowMutations(mutated)
      server.subscribeStatusChanges(statusChanges)
      ingest(server)
      enriched.mockClear()
      mutated.mockClear()
      statusChanges.mockClear()

      vi.setSystemTime(1_000 + AGENT_STATUS_STALE_AFTER_MS + 1)
      ingest(server)

      const [row] = server.getStatusSnapshot()
      expect(row.evidenceObservedAt).toBe(Date.now())
      expect(
        selectFreshExplicitAgentStatus({ handle: HANDLE, paneKey: PANE_KEY, hookRows: [row] })
      ).toMatchObject({ status: 'working', updatedAt: Date.now() })
      expect(enriched).not.toHaveBeenCalled()
      expect(mutated).not.toHaveBeenCalled()
      expect(statusChanges).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not renew freshness from a provider-session-only dismissal remnant', () => {
    const server = new AgentHookServer()
    const freshness = vi.fn()
    server.subscribeStatusFreshness(freshness)
    ingest(server)
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-handle',
        worktreeId: 'worktree',
        providerSession: { key: 'session_id', id: 'resume-me' },
        payload: { state: 'working', prompt: 'ship it', agentType: 'codex' }
      },
      null
    )
    server.dropStatusEntry(PANE_KEY)
    freshness.mockClear()

    ingest(server)

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      paneKey: PANE_KEY,
      providerSessionOnly: true,
      providerSession: { key: 'session_id', id: 'resume-me' }
    })
    expect(freshness).not.toHaveBeenCalled()
  })
})
