import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import {
  makeStructuredAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../shared/agent-status-subject'
import { AgentHookServer } from './server'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const SUBJECT = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'ssh:build-box',
    wslDistro: null,
    workspaceId: 'workspace-one',
    workspaceKind: 'folder'
  },
  'structured-session-one'
)

function summary(
  subject: AgentStatusStructuredSessionSubject = SUBJECT
): AgentSessionStatusSummary {
  return {
    sessionId: subject.sessionId,
    workspaceId: subject.workspaceId,
    agent: 'claude',
    status: 'working',
    hostExecutionOwned: true,
    latestPrompt: 'find the flaky tests',
    updatedAt: 100
  }
}

const started: AgentChildWorkEvidence[] = [
  {
    type: 'live',
    observedAt: 200,
    child: {
      handle: { idKind: 'task_id', id: 'agent-1', runId: 'toolu_1' },
      kind: 'agent',
      residency: 'background',
      state: 'working',
      description: 'Audit the build',
      stoppable: true
    }
  }
]

afterEach(() => vi.restoreAllMocks())

describe('structured child-work ingest', () => {
  it('refuses children of a session whose own row the store does not hold', () => {
    const server = new AgentHookServer()
    expect(server.ingestStructuredChildWork(SUBJECT, started, 'claude')).toBeNull()
    expect(server.getStructuredChildWork(SUBJECT)).toEqual([])
    expect(server.getCanonicalStatusSnapshot().parents).toEqual([])
  })

  it('holds a child under the subject its parent row landed under, and leaves that row alone', () => {
    const server = new AgentHookServer()
    const changed = vi.fn()
    server.ingestStructuredStatus(summary(), SUBJECT)
    const rows = server.getStatusSnapshot()
    server.subscribeStatusChanges(changed)
    expect(server.ingestStructuredChildWork(SUBJECT, started, 'claude')).toMatchObject({
      admitted: 1,
      rejected: []
    })
    expect(server.getStructuredChildWork(SUBJECT)).toEqual([
      expect.objectContaining({
        parent: SUBJECT,
        provider: 'claude',
        description: 'Audit the build',
        membership: 'live'
      })
    ])
    // Nothing reads the records yet: every published row is exactly what it was.
    expect(server.getStatusSnapshot()).toEqual(rows)
    expect(changed).not.toHaveBeenCalled()
  })

  it('drops the children with their parent row', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary(), SUBJECT)
    server.ingestStructuredChildWork(SUBJECT, started, 'claude')
    server.dropStructuredStatus(SUBJECT)
    expect(server.getStructuredChildWork(SUBJECT)).toEqual([])
    expect(server.getCanonicalStatusSnapshot().children).toEqual([])
  })

  it('keeps sessions apart even when their provider ids collide', () => {
    const server = new AgentHookServer()
    const other = makeStructuredAgentStatusSubject(
      {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-two',
        workspaceKind: 'git-worktree'
      },
      'structured-session-two'
    )
    server.ingestStructuredStatus(summary(), SUBJECT)
    server.ingestStructuredStatus(summary(other), other)
    server.ingestStructuredChildWork(SUBJECT, started, 'claude')
    server.ingestStructuredChildWork(other, started, 'claude')
    const [first] = server.getStructuredChildWork(SUBJECT)
    const [second] = server.getStructuredChildWork(other)
    expect(first.childWorkId).not.toBe(second.childWorkId)
    server.ingestStructuredChildWork(other, [{ type: 'session-ended', observedAt: 300 }], 'claude')
    expect(server.getStructuredChildWork(other)).toEqual([
      expect.objectContaining({ childWorkId: second.childWorkId, outcome: 'unknown' })
    ])
    expect(server.getStructuredChildWork(SUBJECT)).toEqual([first])
  })

  it('rejects an address that names no session', () => {
    const server = new AgentHookServer()
    expect(() =>
      server.ingestStructuredChildWork({ ...SUBJECT, sessionId: '' }, started, 'claude')
    ).toThrow('Structured child work requires its exact owner subject')
  })
})
