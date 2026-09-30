import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { isFreshNonDoneAgentStatus } from '../../shared/agent-status-freshness'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
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
  it('stores the projection as a row under the pane key the renderer derives', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary(), SUBJECT)

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: STRUCTURED_PANE,
        tabId: TAB,
        worktreeId: 'repo-1::/workspace/app',
        connectionId: null,
        state: 'working',
        agentType: 'codex',
        prompt: 'ship the thing',
        model: 'gpt-6-astra',
        toolName: 'shell',
        toolInput: 'sleep 30',
        lastAssistantMessage: 'on it',
        structuredHost: 'owned',
        // The journal clock, not the ingest clock: a restart's republish is not new evidence.
        evidenceObservedAt: OBSERVED_AT,
        stateStartedAt: OBSERVED_AT
      })
    ])
    expect(server.getStatusSnapshot()[0]?.observation?.origin).toBe('structured')
  })

  // The same mapping the sidebar applies, so the two surfaces cannot disagree about one session.
  it('maps attention to blocked and idle to done', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary({ status: 'attention' }), SUBJECT)
    expect(server.getStatusSnapshot()[0]?.state).toBe('blocked')
    server.ingestStructuredStatus(summary({ status: 'idle', updatedAt: OBSERVED_AT + 1 }), SUBJECT)
    expect(server.getStatusSnapshot()[0]?.state).toBe('done')
  })

  it('folds live background tasks into an idle session the way the hook lane folds a roster', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(
      summary({
        status: 'idle',
        backgroundTasks: [{ id: 'child-1', kind: 'agent', state: 'working' }]
      }),
      SUBJECT
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('workingMode')

    server.ingestStructuredStatus(
      summary({
        status: 'idle',
        updatedAt: OBSERVED_AT + 1,
        backgroundTasks: [{ id: 'shell-1', kind: 'command', state: 'working' }]
      }),
      SUBJECT
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      workingMode: 'monitoring'
    })

    server.ingestStructuredStatus(
      summary({
        status: 'idle',
        updatedAt: OBSERVED_AT + 2,
        backgroundTasks: [{ id: 'shell-1', kind: 'command', state: 'done' }]
      }),
      SUBJECT
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('workingMode')
  })

  // The timer beside the row belongs to the state it labels: monitoring that becomes a real turn
  // must not report the watch loop's age as how long the agent has been working.
  it('restarts the state clock when monitoring becomes a real turn', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(
      summary({
        status: 'idle',
        backgroundTasks: [{ id: 'shell-1', kind: 'command', state: 'working' }]
      }),
      SUBJECT
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      stateStartedAt: OBSERVED_AT
    })

    server.ingestStructuredStatus(
      summary({
        status: 'working',
        updatedAt: OBSERVED_AT + 2_700_000,
        backgroundTasks: [{ id: 'shell-1', kind: 'command', state: 'working' }]
      }),
      SUBJECT
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      stateStartedAt: OBSERVED_AT + 2_700_000
    })
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('workingMode')
  })

  // `summary.updatedAt` is the journal's last activity, which a background-task edge does not
  // advance. Dating the row by it aged a genuinely live monitoring session past the 30-minute
  // staleness window every reader applies, so freshness is stamped when this host observed it.
  it('dates a task edge by when the host saw it, not by the journal clock', () => {
    const server = new AgentHookServer()
    const before = Date.now()
    server.ingestStructuredStatus(
      summary({
        status: 'idle',
        updatedAt: OBSERVED_AT,
        backgroundTasks: [{ id: 'shell-1', kind: 'command', state: 'working' }]
      }),
      SUBJECT
    )
    const row = server.getStatusSnapshot()[0]
    expect(row).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(row?.evidenceObservedAt).toBeGreaterThanOrEqual(before)
    expect(isFreshNonDoneAgentStatus({ ...row!, updatedAt: row!.evidenceObservedAt! })).toBe(true)
  })

  it('marks a session whose provider child is gone as held, not owned', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary({ hostExecutionOwned: undefined }), SUBJECT)
    expect(server.getStatusSnapshot()[0]?.structuredHost).toBe('held')
  })

  it('keeps the state start while later evidence of the same state arrives', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary(), SUBJECT)
    server.ingestStructuredStatus(
      summary({ toolName: 'read', updatedAt: OBSERVED_AT + 5_000 }),
      SUBJECT
    )

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      toolName: 'read',
      evidenceObservedAt: OBSERVED_AT + 5_000,
      stateStartedAt: OBSERVED_AT
    })
  })

  // Null status means no turn has been persisted; the chat shows nothing, so neither does this.
  it('holds no row for a session without a persisted turn, and drops one that regresses to none', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary({ status: null }), SUBJECT)
    expect(server.getStatusSnapshot()).toEqual([])

    server.ingestStructuredStatus(summary(), SUBJECT)
    server.ingestStructuredStatus(summary({ status: null }), SUBJECT)
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('drops the row when the host stops holding the session', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary(), SUBJECT)
    server.dropStructuredStatus(SUBJECT)
    expect(server.getStatusSnapshot()).toEqual([])
  })

  // The resume-identity remnant a dismissed PTY pane keeps exists so the agent can be resumed in
  // that pane. A structured session has no pane, and the record store owns its resume identity —
  // so a remnant here would be an unclearable row that every null-status publish re-minted.
  it('leaves no resume-identity remnant behind, even carrying a provider session', () => {
    const server = new AgentHookServer()
    const withProviderSession = summary({
      providerSession: { key: 'session_id', id: 'codex-thread-1' }
    })
    server.ingestStructuredStatus(withProviderSession, SUBJECT)
    expect(server.getStatusSnapshot()[0]?.providerSession).toEqual({
      key: 'session_id',
      id: 'codex-thread-1'
    })

    server.dropStructuredStatus(SUBJECT)
    expect(server.getStatusSnapshot()).toEqual([])
  })

  // Structured rows are never serialized, so persisting one could only rewrite the file already
  // on disk — once per debounce window for the whole of every streaming chat.
  // "Exactly one writer per pane key" has to hold for deletes too: the renderer's feed bridge owns
  // this pane, so a pane-status-clear would be main reaching into a row it does not write.
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

  it('schedules no persist for a structured row, while a hook row still does', () => {
    const server = new AgentHookServer()
    const persists: number[] = []
    const scheduled = server as unknown as { scheduleStatusPersist: () => void }
    const original = scheduled.scheduleStatusPersist.bind(server)
    scheduled.scheduleStatusPersist = () => {
      persists.push(1)
      original()
    }

    server.ingestStructuredStatus(summary(), SUBJECT)
    expect(persists).toHaveLength(0)

    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: null,
      payload: { state: 'working', prompt: 'watch the build', agentType: 'claude' }
    })
    expect(persists).toHaveLength(1)
  })

  it('leaves a hook-reported pane alone', () => {
    const server = new AgentHookServer()
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: null,
      payload: { state: 'working', prompt: 'watch the build', agentType: 'claude' }
    })
    server.ingestStructuredStatus(summary(), SUBJECT)

    const byPane = new Map(server.getStatusSnapshot().map((row) => [row.paneKey, row]))
    expect(byPane.get(PANE)?.structuredHost).toBeUndefined()
    expect(byPane.get(STRUCTURED_PANE)?.structuredHost).toBe('owned')
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

  // The journal is the durable truth and the host republishes on restore; a persisted copy would
  // hydrate as unconfirmed and fight that republish.
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

    const file = JSON.parse(readFileSync(lastStatusPath(), 'utf8')) as {
      entries: Record<string, unknown>
    }
    expect(Object.keys(file.entries)).toEqual([PANE])

    const restored = new AgentHookServer()
    await restored.start({ env: 'production', userDataPath })
    try {
      expect(restored.getStatusSnapshot().map((row) => row.paneKey)).toEqual([PANE])
    } finally {
      restored.stop()
    }
  })

  it('are dropped on hydrate if some other writer put one on disk', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [STRUCTURED_PANE]: {
            paneKey: STRUCTURED_PANE,
            tabId: TAB,
            connectionId: null,
            receivedAt: Date.now(),
            stateStartedAt: Date.now(),
            structuredHost: 'owned',
            payload: { state: 'working', prompt: 'ship the thing', agentType: 'codex' }
          }
        }
      })
    )
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      server.stop()
    }
  })
})

describe('the main agent fact on a structured row', () => {
  it('publishes the main agent beside the folded state, on the journal clock with continuity', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(
      summary({ status: 'idle', backgroundTasks: [{ id: 'c', kind: 'agent', state: 'working' }] }),
      SUBJECT
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', stateStartedAt: OBSERVED_AT }
    })
    expect(server.getStatusSnapshot()[0]?.mainAgent).not.toHaveProperty('outcome')

    // The main agent is still done while its child drains: the main agent's clock does not move.
    server.ingestStructuredStatus(
      summary({ status: 'idle', updatedAt: OBSERVED_AT + 5, turnOutcome: 'failure' }),
      SUBJECT
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      stateStartedAt: OBSERVED_AT + 5,
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: OBSERVED_AT }
    })

    server.ingestStructuredStatus(
      summary({ status: 'working', updatedAt: OBSERVED_AT + 9 }),
      SUBJECT
    )
    expect(server.getStatusSnapshot()[0]?.mainAgent).toEqual({
      state: 'working',
      stateStartedAt: OBSERVED_AT + 9
    })
  })

  it('reaches the enriched fanout every legacy subscriber reads', () => {
    const server = new AgentHookServer()
    const enriched = vi.fn()
    server.subscribeEnrichedStatus(enriched)
    server.ingestStructuredStatus(summary({ status: 'idle', turnOutcome: 'cancellation' }), SUBJECT)
    expect(enriched).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: STRUCTURED_PANE,
        payload: expect.objectContaining({
          state: 'done',
          mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: OBSERVED_AT }
        })
      })
    )
  })
})
