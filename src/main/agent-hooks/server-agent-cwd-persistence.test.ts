import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, recentTs, PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const AGENT_SUBDIRECTORY = '/repo/wt-1/packages/api'

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('agent working directory across the hook boundary (STA-5804)', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-agent-cwd-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function writeLastStatus(entry: Record<string, unknown>): void {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      join(userDataPath, 'agent-hooks', 'last-status.json'),
      JSON.stringify({ version: 2, entries: { [PANE]: entry } }),
      'utf8'
    )
  }

  it('forwards the reported directory to the renderer snapshot', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'claude-session-1',
          cwd: AGENT_SUBDIRECTORY,
          prompt: 'fix the parser'
        })
      )

      expect(server.getStatusSnapshotForPane(PANE)[0]?.agentCwd).toBe(AGENT_SUBDIRECTORY)
    } finally {
      server.stop()
    }
  })

  it('restores the directory from last-status.json after a restart', async () => {
    const receivedAt = recentTs()
    writeLastStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      agentCwd: AGENT_SUBDIRECTORY,
      receivedAt,
      stateStartedAt: receivedAt,
      payload: { state: 'working', prompt: 'fix the parser', agentType: 'claude' }
    })

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshotForPane(PANE)[0]?.agentCwd).toBe(AGENT_SUBDIRECTORY)
    } finally {
      server.stop()
    }
  })

  it('leaves a pre-existing entry with no directory unknown, never the worktree', async () => {
    const receivedAt = recentTs()
    writeLastStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      receivedAt,
      stateStartedAt: receivedAt,
      payload: { state: 'working', prompt: 'fix the parser', agentType: 'claude' }
    })

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const row = server.getStatusSnapshotForPane(PANE)[0]
      expect(row?.worktreeId).toBe('wt-1')
      expect(row?.agentCwd).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('rejects a persisted directory that is not an absolute path', async () => {
    const receivedAt = recentTs()
    writeLastStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      agentCwd: 'packages/api',
      receivedAt,
      stateStartedAt: receivedAt,
      payload: { state: 'working', prompt: 'fix the parser', agentType: 'claude' }
    })

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshotForPane(PANE)[0]?.agentCwd).toBeUndefined()
    } finally {
      server.stop()
    }
  })
  it('keeps the directory when an OSC status keeps the session', async () => {
    // OSC 9999 carries neither a session id nor a directory, so it is no evidence the agent
    // moved. The session survives it (#10630); the directory has to survive it the same way.
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'claude-session-1',
          cwd: AGENT_SUBDIRECTORY,
          prompt: 'fix the parser'
        })
      )

      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        payload: { state: 'done', prompt: 'fix the parser', agentType: 'claude' }
      })

      const row = server.getStatusSnapshotForPane(PANE)[0]
      expect(row?.providerSession).toEqual({ key: 'session_id', id: 'claude-session-1' })
      expect(row?.agentCwd).toBe(AGENT_SUBDIRECTORY)
    } finally {
      server.stop()
    }
  })

  it('drops the directory when the OSC status starts a new turn after done', async () => {
    // A new turn on a finished pane is where the session is dropped too — the pane may be
    // running something started somewhere else, so the directory is unknown, not inherited.
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'Stop',
          session_id: 'claude-session-1',
          cwd: AGENT_SUBDIRECTORY,
          prompt: 'fix the parser'
        })
      )
      expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('done')

      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        payload: { state: 'working', prompt: 'something else', agentType: 'claude' }
      })

      const row = server.getStatusSnapshotForPane(PANE)[0]
      expect(row?.providerSession).toBeUndefined()
      expect(row?.agentCwd).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('keeps the directory when interrupt inference preserves the provider session', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'claude-session-1',
          cwd: AGENT_SUBDIRECTORY,
          prompt: 'fix the parser'
        })
      )
      const baseline = server.getStatusSnapshotForPane(PANE)[0]!

      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'fix the parser',
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(true)
      expect(server.getStatusSnapshotForPane(PANE)[0]?.agentCwd).toBe(AGENT_SUBDIRECTORY)
    } finally {
      server.stop()
    }
  })

  it('carries a remote agent directory across the SSH relay boundary', () => {
    const server = new AgentHookServer()
    const rendererListener = vi.fn()
    server.setListener(rendererListener)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session-1' },
        agentCwd: '/srv/checkout/packages/api',
        payload: { state: 'working', prompt: 'fix the parser', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(rendererListener).toHaveBeenCalledWith(
      expect.objectContaining({ agentCwd: '/srv/checkout/packages/api' })
    )
  })

  it('rejects a relative directory arriving over the relay', () => {
    const server = new AgentHookServer()
    const rendererListener = vi.fn()
    server.setListener(rendererListener)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session-1' },
        agentCwd: '../escape',
        payload: { state: 'working', prompt: 'fix the parser', agentType: 'claude' }
      },
      'conn-1'
    )

    const forwarded = rendererListener.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(forwarded).toBeDefined()
    expect(forwarded?.agentCwd).toBeUndefined()
  })
})
