import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import type { AgentRunAccount } from '../../shared/agent-run-account'
import { selectRuntimeHookAgentRowForPane } from '../runtime/runtime-mobile-agent-status-projection'

const PANE_KEY = 'tab-run:33333333-3333-4333-8333-333333333333'
const MOVED_PANE_KEY = 'tab-moved:44444444-4444-4444-8444-444444444444'

const KEPT: AgentRunAccount = {
  provider: 'codex',
  lane: 'host',
  accountId: 'account-a',
  mode: 'kept'
}

function ingest(server: AgentHookServer, overrides: Record<string, unknown> = {}): void {
  server.ingestTerminalStatus({
    paneKey: PANE_KEY,
    tabId: 'tab-run',
    worktreeId: 'worktree',
    connectionId: null,
    payload: { state: 'working', prompt: 'ship it', agentType: 'codex' },
    ...overrides
  })
}

class ProbeServer extends AgentHookServer {
  persistRequests = 0
  protected override scheduleStatusPersist(): void {
    this.persistRequests += 1
    super.scheduleStatusPersist()
  }
  serialized(): string {
    return this.serializeStatusFile()
  }
}

function row(server: AgentHookServer, paneKey = PANE_KEY) {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === paneKey)
}

describe('run-account facet on status rows', () => {
  it('restates only the facet: same clocks, persisted, renderer only', () => {
    const server = new ProbeServer()
    ingest(server)
    const before = row(server)!
    const renderer = vi.fn()
    server.setListener(renderer)
    renderer.mockClear()
    const enriched = vi.fn()
    const statusChanges = vi.fn()
    const mutations = vi.fn()
    server.subscribeEnrichedStatus(enriched)
    server.subscribeStatusChanges(statusChanges)
    server.subscribeStatusRowMutations(mutations)
    const persistRequestsBefore = server.persistRequests

    expect(server.republishRunAccount(PANE_KEY, KEPT)).toBe(true)

    const after = row(server)!
    expect(after.runAccount).toEqual(KEPT)
    expect(after.receivedAt).toBe(before.receivedAt)
    expect(after.stateStartedAt).toBe(before.stateStartedAt)
    expect(after.state).toBe('working')
    expect(server.persistRequests - persistRequestsBefore).toBe(1)
    expect(renderer).toHaveBeenCalledTimes(1)
    expect(renderer.mock.calls[0]![0]).toMatchObject({
      paneKey: PANE_KEY,
      runAccount: KEPT,
      receivedAt: before.receivedAt,
      stateStartedAt: before.stateStartedAt,
      isReplay: true,
      runAccountOnly: true
    })
    expect(enriched).not.toHaveBeenCalled()
    expect(statusChanges).not.toHaveBeenCalled()
    expect(mutations).not.toHaveBeenCalled()
    expect(JSON.parse(server.serialized()).entries[PANE_KEY].runAccount).toEqual(KEPT)
    expect(JSON.parse(server.serialized()).entries[PANE_KEY]).not.toHaveProperty('runAccountOnly')
  })

  it('is a no-op for an equal facet, an unknown pane and a relay row', () => {
    const server = new AgentHookServer()
    ingest(server)
    expect(server.republishRunAccount(PANE_KEY, KEPT)).toBe(true)
    const renderer = vi.fn()
    server.setListener(renderer)
    renderer.mockClear()

    expect(server.republishRunAccount(PANE_KEY, { ...KEPT })).toBe(false)
    expect(server.republishRunAccount('tab-none:55555555-5555-4555-8555-555555555555', KEPT)).toBe(
      false
    )
    ingest(server, { paneKey: MOVED_PANE_KEY, tabId: 'tab-moved', connectionId: 'ssh-1' })
    renderer.mockClear()
    expect(server.republishRunAccount(MOVED_PANE_KEY, KEPT)).toBe(false)
    expect(renderer).not.toHaveBeenCalled()
  })

  it('withdraws a facet with an explicit null the renderer can see', () => {
    const server = new AgentHookServer()
    ingest(server)
    server.republishRunAccount(PANE_KEY, KEPT)

    expect(server.republishRunAccount(PANE_KEY, null)).toBe(true)
    expect(row(server)?.runAccount).toBeNull()
    expect(server.getRunAccountRow(PANE_KEY)?.runAccount).toBeUndefined()
  })

  it('keeps the facet across later rows of the same agent', () => {
    const server = new AgentHookServer()
    ingest(server)
    server.republishRunAccount(PANE_KEY, KEPT)

    ingest(server, { payload: { state: 'done', prompt: 'ship it', agentType: 'codex' } })
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-run',
        worktreeId: 'worktree',
        providerSession: { key: 'session_id', id: 'session-1' },
        payload: { state: 'working', prompt: 'next', agentType: 'codex' }
      },
      null
    )

    expect(row(server)).toMatchObject({ state: 'working', runAccount: KEPT })
  })

  it('drops the facet when another agent takes the pane', () => {
    const server = new AgentHookServer()
    ingest(server)
    server.republishRunAccount(PANE_KEY, KEPT)
    ingest(server, { payload: { state: 'done', prompt: 'ship it', agentType: 'codex' } })
    expect(row(server)?.runAccount).toEqual(KEPT)

    ingest(server, { payload: { state: 'working', prompt: 'hi', agentType: 'claude' } })

    expect(row(server)?.agentType).toBe('claude')
    expect(row(server)).not.toHaveProperty('runAccount')
  })

  it('moves with the row when the pane moves to another tab', () => {
    const server = new AgentHookServer()
    ingest(server)
    server.republishRunAccount(PANE_KEY, KEPT)

    server.transferPaneAuthority(PANE_KEY, MOVED_PANE_KEY, 'pty-1')

    expect(row(server, MOVED_PANE_KEY)?.runAccount).toEqual(KEPT)
    expect(server.getRunAccountRow(PANE_KEY)).toMatchObject({
      paneKey: MOVED_PANE_KEY,
      runAccount: KEPT
    })
  })

  it('reaches the host snapshot but not the paired-client projection', () => {
    const server = new AgentHookServer()
    ingest(server)
    server.republishRunAccount(PANE_KEY, KEPT)

    const snapshot = server.getStatusSnapshot()
    expect(snapshot[0]?.runAccount).toEqual(KEPT)
    const projected = selectRuntimeHookAgentRowForPane(snapshot)
    expect(projected.live?.payload.state).toBe('working')
    expect(JSON.stringify(projected)).not.toContain('account-a')
  })
})
