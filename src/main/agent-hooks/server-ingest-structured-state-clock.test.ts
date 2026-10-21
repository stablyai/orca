// The host's status row takes its state clock from the summary's `statusStartedAt`, the session's
// own lifecycle clock, so `worktree ps`, mobile and the dashboard date a parent the way the sidebar
// does. An older summary without the clock keeps the ingest's own continuity rule.

import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { AgentHookServer, _internals } from './server'

const SESSION = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const SUBJECT = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'repo-1::/workspace/app',
    workspaceKind: 'git-worktree'
  },
  SESSION
)
const SETTLED = 22_000

function summary(over: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: SESSION,
    workspaceId: 'repo-1::/workspace/app',
    agent: 'codex',
    status: 'idle',
    hostExecutionOwned: true,
    latestPrompt: 'fan out',
    updatedAt: SETTLED,
    ...over
  }
}

const CHILD = { idKind: 'task_id', id: 'child-1' } as const

function liveChild(observedAt: number): AgentChildWorkEvidence {
  return {
    type: 'live',
    observedAt,
    child: {
      handle: CHILD,
      kind: 'agent',
      residency: 'background',
      state: 'working',
      stoppable: true
    }
  }
}

function row(server: AgentHookServer) {
  return server.getStatusSnapshot()[0]
}

beforeEach(() => {
  _internals.resetCachesForTests()
})

describe("the host row's state clock", () => {
  it("dates a subagent's approval at the ask, and the parent's completion where it was", () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary({ statusStartedAt: SETTLED }), SUBJECT)
    server.ingestStructuredStatus(
      summary({ status: 'attention', statusStartedAt: 27_000, updatedAt: 27_000 }),
      SUBJECT
    )
    expect(row(server)).toMatchObject({
      state: 'blocked',
      stateStartedAt: 27_000,
      mainAgent: { state: 'blocked', stateStartedAt: 27_000 }
    })

    server.ingestStructuredStatus(summary({ statusStartedAt: SETTLED, updatedAt: 28_500 }), SUBJECT)
    expect(row(server)).toMatchObject({
      state: 'done',
      stateStartedAt: SETTLED,
      mainAgent: { state: 'done', stateStartedAt: SETTLED }
    })
  })

  it('settles a row child work held open on the parent clock, not the last child row', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(
      summary({ status: 'working', statusStartedAt: 10_000, updatedAt: 10_000 }),
      SUBJECT
    )
    // The row reads child liveness from the host's records, not the summary's task list.
    server.ingestStructuredChildWork(SUBJECT, [liveChild(23_000)], 'codex')
    server.ingestStructuredStatus(summary({ statusStartedAt: SETTLED, updatedAt: 24_000 }), SUBJECT)
    expect(row(server)).toMatchObject({ state: 'working', stateStartedAt: 10_000 })

    server.ingestStructuredChildWork(
      SUBJECT,
      [{ type: 'ended', observedAt: 25_000, handle: CHILD, outcome: 'succeeded' }],
      'codex'
    )
    server.ingestStructuredStatus(summary({ statusStartedAt: SETTLED, updatedAt: 26_000 }), SUBJECT)
    expect(row(server)).toMatchObject({ state: 'done', stateStartedAt: SETTLED })
  })

  it("keeps the ingest's own continuity for an older host's summary, which carries no clock", () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary(), SUBJECT)
    server.ingestStructuredStatus(summary({ status: 'attention', updatedAt: 27_000 }), SUBJECT)
    server.ingestStructuredStatus(summary({ updatedAt: 28_500 }), SUBJECT)
    expect(row(server)).toMatchObject({
      state: 'done',
      stateStartedAt: 28_500,
      mainAgent: { state: 'done', stateStartedAt: 28_500 }
    })
  })
})
