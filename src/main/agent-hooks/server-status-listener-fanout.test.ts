import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, GOOD_PANE } from './server.test-fixtures'

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

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer listener replay', () => {
  it('evicts only the matching persisted status identity', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        providerSession: { key: 'session_id', id: 'resume-me' },
        payload: { state: 'done', prompt: 'old run', agentType: 'claude' }
      },
      'conn-1'
    )
    const old = server.getStatusSnapshot()[0]
    expect(old).toBeDefined()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'new run', agentType: 'claude' }
      },
      'conn-1'
    )
    server.dropPersistedStatusEntry({
      paneKey: old!.paneKey,
      receivedAt: old!.receivedAt,
      stateStartedAt: old!.stateStartedAt
    })

    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', prompt: 'new run' })

    // Matching eviction retains provider identity so the surviving TUI can resume.
    const resumed = new AgentHookServer()
    resumed.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        providerSession: { key: 'session_id', id: 'resume-me' },
        payload: { state: 'done', prompt: 'old run', agentType: 'claude' }
      },
      'conn-1'
    )
    const resumedIdentity = resumed.getStatusSnapshot()[0]!
    expect(
      resumed.dropPersistedStatusEntry({
        paneKey: resumedIdentity.paneKey,
        receivedAt: resumedIdentity.receivedAt,
        stateStartedAt: resumedIdentity.stateStartedAt
      })
    ).toBe(true)
    expect(resumed.getStatusSnapshot()[0]).toMatchObject({
      providerSessionOnly: true,
      providerSession: { id: 'resume-me' }
    })
  })

  it('emits a connection cutoff after a pane-key collision and orders replay after it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const server = new AgentHookServer()
    const clearListener = vi.fn()
    server.setPaneStatusClearListener(clearListener)
    server.ingestRemote(
      { paneKey: PANE, payload: { state: 'working', agentType: 'claude' } },
      'ssh-a'
    )
    server.ingestRemote(
      { paneKey: PANE, payload: { state: 'working', agentType: 'codex' } },
      'ssh-b'
    )

    server.clearStatusEntriesForConnection('ssh-a')
    const clear = clearListener.mock.calls[0]?.[0] as {
      transient: true
      connectionId: string
      clearedAt: number
    }
    server.ingestRemote(
      { paneKey: GOOD_PANE, payload: { state: 'working', agentType: 'claude' }, isReplay: true },
      'ssh-a'
    )

    expect(clear).toMatchObject({ transient: true, connectionId: 'ssh-a' })
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE, connectionId: 'ssh-b' }),
      expect.objectContaining({
        paneKey: GOOD_PANE,
        connectionId: 'ssh-a',
        receivedAt: clear.clearedAt + 1
      })
    ])
    vi.useRealTimers()
  })

  it('hydrates cached statuses as not observed in the current runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-agent-hooks-'))
    const firstServer = new AgentHookServer()
    const secondServer = new AgentHookServer()
    try {
      await firstServer.start({ env: 'production', userDataPath: dir })
      firstServer.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', agentType: 'claude' }
        },
        'conn-1'
      )
      firstServer.flushStatusPersistSync()
      firstServer.stop()

      await secondServer.start({ env: 'production', userDataPath: dir })

      expect(secondServer.getStatusChangeSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          observedInCurrentRuntime: false
        })
      ])
    } finally {
      firstServer.stop()
      secondServer.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replays the latest retained pane status when a listener attaches after windowless events', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      expect(env.ORCA_AGENT_HOOK_PORT).toBeTruthy()
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBeTruthy()

      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({
            hook_event_name: 'UserPromptSubmit',
            prompt: 'replay me'
          })
        )
      })
      expect(response.status).toBe(204)

      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          connectionId: null,
          receivedAt: expect.any(Number),
          stateStartedAt: expect.any(Number),
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'replay me',
            agentType: 'claude'
          })
        })
      )
    } finally {
      server.stop()
    }
  })
})
