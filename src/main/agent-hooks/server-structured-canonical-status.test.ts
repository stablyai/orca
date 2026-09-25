import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeStructuredAgentStatusSubject,
  type AgentStatusExecutionScope,
  type AgentStatusStructuredSessionSubject
} from '../../shared/agent-status-subject'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { AgentHookServer } from './server'
import { GOOD_PANE, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const SESSION = 'canonical-session-one'
const SCOPE: AgentStatusExecutionScope = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-one',
  workspaceKind: 'git-worktree'
}
const SUBJECT = makeStructuredAgentStatusSubject(SCOPE, SESSION)
const PANE_KEY = structuredAgentSessionPaneKey(structuredAgentSessionTabId(SESSION), SESSION)

function summary(
  subject: AgentStatusStructuredSessionSubject = SUBJECT
): AgentSessionStatusSummary {
  return {
    sessionId: subject.sessionId,
    workspaceId: subject.workspaceId,
    agent: 'codex',
    status: 'working',
    hostExecutionOwned: true,
    latestPrompt: 'trusted journal',
    updatedAt: 100
  }
}

function terminal(server: AgentHookServer, paneKey: string): void {
  server.ingestTerminalStatus({
    paneKey,
    worktreeId: SCOPE.workspaceId,
    connectionId: null,
    payload: { state: 'working', prompt: 'legacy PTY', agentType: 'claude' }
  })
}

afterEach(() => vi.restoreAllMocks())

describe('structured canonical production slice', () => {
  it('stores once canonically and supplies every legacy reader from that row', () => {
    const server = new AgentHookServer()
    const changed = vi.fn()
    const enriched = vi.fn()
    server.subscribeStatusChanges(changed)
    server.subscribeEnrichedStatus(enriched)
    server.ingestStructuredStatus(summary(), SUBJECT)
    expect(server._getStateForTests().lastStatusByPaneKey.size).toBe(0)
    expect(server.getCanonicalStatusSnapshot().parents).toEqual([
      expect.objectContaining({
        subject: SUBJECT,
        status: expect.objectContaining({ paneKey: PANE_KEY })
      })
    ])
    expect(server.getStatusSnapshotForPane(PANE_KEY)).toEqual(server.getStatusSnapshot())
    expect(changed).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        paneKey: PANE_KEY,
        state: 'working',
        observedInCurrentRuntime: true
      })
    ])
    expect(enriched).toHaveBeenCalledOnce()
    const replay = vi.fn()
    server.setListener(replay)
    expect(replay).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ paneKey: PANE_KEY, isReplay: true })
    )
  })

  it('keeps mixed legacy enumeration in original insertion order through updates and re-admission', () => {
    vi.spyOn(Date, 'now').mockReturnValue(200)
    const server = new AgentHookServer()
    const second = makeStructuredAgentStatusSubject(SCOPE, 'canonical-session-two')
    const secondPane = structuredAgentSessionPaneKey(
      structuredAgentSessionTabId(second.sessionId),
      second.sessionId
    )
    const baseline = new Map<string, string>()
    terminal(server, PANE)
    baseline.set(PANE, 'legacy PTY')
    server.ingestStructuredStatus(summary(), SUBJECT)
    baseline.set(PANE_KEY, 'trusted journal')
    terminal(server, GOOD_PANE)
    baseline.set(GOOD_PANE, 'legacy PTY')
    server.ingestStructuredStatus(summary(second), second)
    baseline.set(secondPane, 'trusted journal')
    terminal(server, PANE)
    server.ingestStructuredStatus({ ...summary(), latestPrompt: 'updated' }, SUBJECT)
    baseline.set(PANE_KEY, 'updated')
    const listing = () => server.getStatusSnapshot().map((row) => [row.paneKey, row.prompt])
    expect(listing()).toEqual([...baseline])
    expect(server.getStatusChangeSnapshot().map((row) => row.paneKey)).toEqual([...baseline.keys()])
    const replay: string[] = []
    server.setListener((entry) => replay.push(entry.paneKey))
    expect(replay).toEqual([...baseline.keys()])
    server.dropStructuredStatus(SUBJECT)
    baseline.delete(PANE_KEY)
    server.ingestStructuredStatus(summary(), SUBJECT)
    baseline.set(PANE_KEY, 'trusted journal')
    expect(listing()).toEqual([...baseline])
    const relocated = makePaneKey('relocated-tab', '88888888-8888-4888-8888-888888888888')
    server.transferPaneAuthority(PANE, relocated, undefined, 200, { authorityVerified: true })
    baseline.delete(PANE)
    baseline.set(relocated, 'legacy PTY')
    expect(listing()).toEqual([...baseline])
    expect(server._getStateForTests().lastStatusByPaneKey.size).toBe(2)
    expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(2)
  })

  it('isolates identical session identifiers across host, WSL and workspace kind scopes', () => {
    const server = new AgentHookServer()
    const scopes: AgentStatusExecutionScope[] = [
      SCOPE,
      { ...SCOPE, wslDistro: 'Ubuntu' },
      { ...SCOPE, wslDistro: 'Debian' },
      { ...SCOPE, executionHostId: 'ssh:first' },
      { ...SCOPE, executionHostId: 'ssh:second' },
      { ...SCOPE, executionHostId: 'runtime:paired' },
      { ...SCOPE, workspaceKind: 'folder' }
    ]
    const subjects = scopes.map((scope) => makeStructuredAgentStatusSubject(scope, SESSION))
    for (const subject of subjects) {
      server.ingestStructuredStatus(summary(subject), subject)
    }
    expect(server.getCanonicalStatusSnapshot().parents.map((row) => row.subject)).toEqual(subjects)
    server.dropStructuredStatus(SUBJECT)
    expect(server.getCanonicalStatusSnapshot().parents.map((row) => row.subject)).toEqual(
      subjects.slice(1)
    )
    expect(server._getStateForTests().lastStatusByPaneKey.size).toBe(0)
  })

  it('rejects missing or mismatched structured scope without fabricating a parent', () => {
    const server = new AgentHookServer()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: models a caller at an untyped boundary (e.g. IPC) invoking with fewer arguments than the method declares; no typed call expresses a missing required parameter.
    const ingestMissingSubject = server.ingestStructuredStatus.bind(server) as unknown as (
      summary: AgentSessionStatusSummary
    ) => void
    expect(() => ingestMissingSubject(summary())).toThrow('trusted owner subject')
    expect(() =>
      server.ingestStructuredStatus({ ...summary(), workspaceId: 'other' }, SUBJECT)
    ).toThrow('trusted owner subject')
    expect(server.getCanonicalStatusSnapshot().parents).toEqual([])
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('refuses late PTY and relay evidence at a canonically owned address without fanout', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary(), SUBJECT)
    const before = server.getCanonicalStatusSnapshot()
    const changed = vi.fn()
    const enriched = vi.fn()
    server.subscribeStatusChanges(changed)
    server.subscribeEnrichedStatus(enriched)
    terminal(server, PANE_KEY)
    server.ingestRemote(
      { paneKey: PANE_KEY, payload: { state: 'done', prompt: 'late', agentType: 'claude' } },
      'ssh-route'
    )
    expect(server.getCanonicalStatusSnapshot()).toEqual(before)
    expect(server._getStateForTests().lastStatusByPaneKey.size).toBe(0)
    expect(server.getStatusSnapshot()).toHaveLength(1)
    expect(changed).not.toHaveBeenCalled()
    expect(enriched).not.toHaveBeenCalled()
  })

  it('refuses a canonical address already occupied by unbound legacy evidence', () => {
    const server = new AgentHookServer()
    terminal(server, PANE_KEY)
    expect(() => server.ingestStructuredStatus(summary(), SUBJECT)).toThrow(
      'conflicts with legacy evidence'
    )
    expect(server.getCanonicalStatusSnapshot().parents).toEqual([])
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, prompt: 'legacy PTY' })
    ])
  })

  it('keeps incomplete remote evidence exclusively legacy and pane cleanup cannot remove a canonical row', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      { paneKey: PANE, payload: { state: 'working', prompt: 'remote', agentType: 'claude' } },
      'ssh-route'
    )
    expect(server.getCanonicalStatusSnapshot().parents).toEqual([])
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      connectionId: 'ssh-route',
      paneKey: PANE
    })
    server.ingestStructuredStatus(summary(), SUBJECT)
    server.dropStatusEntry(PANE_KEY)
    server.retirePaneAuthority(PANE_KEY)
    expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(1)
    expect(server.getStatusSnapshotForPane(PANE_KEY)).toHaveLength(1)
  })

  it('clears canonical state and renews the owner epoch when the server stops', async () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary(), SUBJECT)
    const epoch = server.getCanonicalStatusSnapshot().epoch
    await server.stop()
    expect(server.getCanonicalStatusSnapshot().parents).toEqual([])
    expect(server.getCanonicalStatusSnapshot().epoch).not.toBe(epoch)
    expect(server.getStatusSnapshot()).toEqual([])
  })
})
