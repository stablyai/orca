import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeStructuredAgentStatusSubject,
  type AgentStatusExecutionScope,
  type AgentStatusStructuredSessionSubject
} from '../../shared/agent-status/contracts/agent-status-subject'
import type { AgentSessionStatusSummary } from '../../shared/agent-session/agent-session-wire'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/agent-session/view/structured-agent-session-projection'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'

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
    expect(server.getProviderSessionSourceRowsForTab(structuredAgentSessionTabId(SESSION))).toEqual(
      server.getStatusSnapshot()
    )
    server.dropStructuredStatus(SUBJECT)
    expect(server.getCanonicalStatusSnapshot().parents.map((row) => row.subject)).toEqual(
      subjects.slice(1)
    )
    expect(server._getStateForTests().lastStatusByPaneKey.size).toBe(0)
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
})
