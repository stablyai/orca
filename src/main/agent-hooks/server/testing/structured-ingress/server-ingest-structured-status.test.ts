import { readSavedStatus } from '../persistence/last-status.test-fixtures'
import { makeStructuredAgentStatusSubject } from '../../../../../shared/agent-status/contracts/agent-status-subject'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SUBJECT = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'repo-1::/workspace/app',
    workspaceKind: 'git-worktree'
  },
  SESSION
)
const TAB = structuredAgentSessionTabId(SESSION)
const STRUCTURED_PANE = structuredAgentSessionPaneKey(TAB, SESSION)
const OBSERVED_AT = 1_757_030_400_000

function liveChild(id: string, kind: 'agent' | 'command'): AgentChildWorkEvidence {
  return {
    type: 'live',
    observedAt: OBSERVED_AT,
    child: {
      handle: { idKind: 'task_id', id },
      kind,
      residency: 'background',
      state: 'working',
      stoppable: true
    }
  }
}

function endedChild(id: string): AgentChildWorkEvidence {
  return {
    type: 'ended',
    observedAt: OBSERVED_AT + 1,
    handle: { idKind: 'task_id', id },
    outcome: 'succeeded'
  }
}

function summary(over: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: SESSION,
    workspaceId: 'repo-1::/workspace/app',
    agent: 'codex',
    status: 'working',
    hostExecutionOwned: true,
    latestPrompt: 'ship the thing',
    model: 'gpt-6-astra',
    toolName: 'shell',
    toolInput: 'sleep 30',
    lastAssistantMessage: 'on it',
    updatedAt: OBSERVED_AT,
    ...over
  }
}

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer ingestStructuredStatus', () => {
  it('retains early child work through status-less parent publications until the owner forgets it', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary({ status: null }), SUBJECT)
    server.ingestStructuredChildWork(SUBJECT, [liveChild('child-1', 'agent')], 'codex')
    server.ingestStructuredStatus(summary({ status: null }), SUBJECT)
    expect(server.getStatusSnapshot()).toEqual([])
    server.ingestStructuredStatus(summary({ status: 'idle' }), SUBJECT)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' }
    })
    server.ingestStructuredStatus(summary({ status: null }), SUBJECT)
    expect(server.getStatusSnapshot()).toEqual([])
    server.ingestStructuredStatus(summary({ status: 'idle' }), SUBJECT)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' }
    })
    server.ingestStructuredChildWork(SUBJECT, [endedChild('child-1')], 'codex')
    server.ingestStructuredStatus(summary({ status: 'idle' }), SUBJECT)
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
    server.dropStructuredStatus(SUBJECT)
    expect(server.getStructuredChildWorkViews(SUBJECT)).toEqual([])
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it("reads child liveness from the host's records, never from the summary's task list", () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(
      summary({
        status: 'idle',
        backgroundTasks: [{ id: 'child-1', kind: 'agent', state: 'working' }]
      }),
      SUBJECT
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
  })

  // The renderer feed owns structured panes, so host deletion must neither clear them nor rewrite hook persistence.
  it('drops the row without sending the renderer a clear for a pane it does not write', () => {
    const server = new AgentHookServer()
    const cleared: unknown[] = []
    const dropped: string[] = []
    server.setPaneStatusClearListener((clear) => cleared.push(clear))
    server.subscribeStatusDrop((paneKey) => dropped.push(paneKey))

    server.ingestStructuredStatus(summary(), SUBJECT)
    server.dropStructuredStatus(SUBJECT)

    expect(server.getStatusSnapshot()).toEqual([])
    expect(cleared).toEqual([])
    expect(dropped).toEqual([STRUCTURED_PANE])
  })
})

describe('structured rows and last-status.json', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-structured-status-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function lastStatusPath(): string {
    return join(userDataPath, 'agent-hooks', 'last-status.json')
  }

  // Restore republishes from the journal; a second persisted copy would compete as unconfirmed state.
  it('are never written, while hook rows still are', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      server.ingestTerminalStatus({
        paneKey: PANE,
        connectionId: null,
        payload: { state: 'working', prompt: 'watch the build', agentType: 'claude' }
      })
      server.ingestStructuredStatus(summary(), SUBJECT)
      server.flushStatusPersistSync()
    } finally {
      server.stop()
    }

    const file: {
      entries: Record<string, unknown>
    } = JSON.parse(readSavedStatus(lastStatusPath()))
    expect(Object.keys(file.entries)).toEqual([PANE])

    const restored = new AgentHookServer()
    await restored.start({ env: 'production', userDataPath })
    try {
      expect(restored.getStatusSnapshot().map((row) => row.paneKey)).toEqual([PANE])
    } finally {
      restored.stop()
    }
  })
})
