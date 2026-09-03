import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  buildBody,
  PANE,
  GOOD_PANE,
  type AgentHookServerCacheInternals
} from './server.test-fixtures'

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
  it('allows multiple status-change subscribers to observe the same update', () => {
    const server = new AgentHookServer()
    const first = vi.fn()
    const second = vi.fn()
    server.subscribeStatusChanges(first)
    server.subscribeStatusChanges(second)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(first).toHaveBeenCalledWith([
      expect.objectContaining({
        state: 'working',
        receivedAt: expect.any(Number),
        observedInCurrentRuntime: true
      })
    ])
    expect(second).toHaveBeenCalledWith([
      expect.objectContaining({
        state: 'working',
        receivedAt: expect.any(Number),
        observedInCurrentRuntime: true
      })
    ])
  })

  it('notifies provider-session subscribers without changing status listener arguments', () => {
    const server = new AgentHookServer()
    const statuses = vi.fn()
    const sessions = vi.fn()
    server.subscribeStatusChanges(statuses)
    server.subscribeProviderSessionChanges(sessions)

    server.ingestRemote(
      {
        paneKey: PANE,
        worktreeId: 'wt-1',
        providerSession: {
          key: 'session_id',
          id: 'pi-session-1',
          transcriptPath: '/tmp/pi-session-1.jsonl'
        },
        providerSessionOnly: true,
        payload: { state: 'done', agentType: 'pi' }
      },
      'conn-1'
    )

    expect(statuses).toHaveBeenCalledWith([])
    expect(sessions).toHaveBeenCalledWith([
      {
        paneKey: PANE,
        sessionId: 'pi-session-1',
        transcriptPath: '/tmp/pi-session-1.jsonl',
        worktreeId: 'wt-1'
      }
    ])
  })

  it('keeps status-change subscribers when renderer fanout listener is cleared', () => {
    const server = new AgentHookServer()
    const statusChangeListener = vi.fn()
    const rendererListener = vi.fn()
    server.subscribeStatusChanges(statusChangeListener)
    server.setListener(rendererListener)
    server.setListener(null)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(statusChangeListener).toHaveBeenCalledTimes(1)
    expect(rendererListener).not.toHaveBeenCalled()
  })

  it('marks listener replay callbacks as replayed', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'cached task', agentType: 'codex' }
      },
      'conn-1'
    )

    const listener = vi.fn()
    server.setListener(listener)

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: PANE,
        isReplay: true,
        payload: expect.objectContaining({ state: 'working', prompt: 'cached task' })
      })
    )
  })

  it('unsubscribes status-change listeners without removing the remaining listeners', () => {
    const server = new AgentHookServer()
    const removed = vi.fn()
    const remaining = vi.fn()
    const unsubscribe = server.subscribeStatusChanges(removed)
    server.subscribeStatusChanges(remaining)

    unsubscribe()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(removed).not.toHaveBeenCalled()
    expect(remaining).toHaveBeenCalledWith([
      expect.objectContaining({
        state: 'working',
        observedInCurrentRuntime: true
      })
    ])
  })

  it('notifies status-change subscribers when a working status is dropped or cleared', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.subscribeStatusChanges(listener)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )
    server.dropStatusEntry(PANE)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )
    server.clearPaneState(PANE)

    expect(listener).toHaveBeenNthCalledWith(2, [])
    expect(listener).toHaveBeenNthCalledWith(4, [])
  })

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

    // A matching eviction follows ordinary dismissal semantics, including
    // preserving a resumable provider session for the still-live TUI.
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

  it('evicts when the renderer identity was stamped after receipt but pins the same turn', () => {
    // Runtime-sync and recovery entries stamp updatedAt with Date.now()/capturedAt, which is
    // at or after main's receivedAt; the eviction must still land for those rows.
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'done', prompt: 'run', agentType: 'claude' }
      },
      'conn-1'
    )
    const entry = server.getStatusSnapshot()[0]!
    expect(
      server.dropPersistedStatusEntry({
        paneKey: entry.paneKey,
        receivedAt: entry.receivedAt + 5_000,
        stateStartedAt: entry.stateStartedAt
      })
    ).toBe(true)

    // A different turn never matches, whatever the receivedAt relationship.
    const other = new AgentHookServer()
    other.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'done', prompt: 'run', agentType: 'claude' }
      },
      'conn-1'
    )
    const otherEntry = other.getStatusSnapshot()[0]!
    expect(
      other.dropPersistedStatusEntry({
        paneKey: otherEntry.paneKey,
        receivedAt: otherEntry.receivedAt + 5_000,
        stateStartedAt: otherEntry.stateStartedAt + 1
      })
    ).toBe(false)
  })

  it('evicts a batch of persisted identities with one status-change notification', () => {
    const server = new AgentHookServer()
    const otherPane = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')
    for (const paneKey of [PANE, otherPane]) {
      server.ingestRemote(
        {
          paneKey,
          tabId: paneKey.split(':')[0]!,
          worktreeId: 'wt-1',
          payload: { state: 'done', prompt: 'run', agentType: 'claude' }
        },
        'conn-1'
      )
    }
    const listener = vi.fn()
    server.subscribeStatusChanges(listener)
    const dropped: string[] = []
    server.subscribeStatusDrop((paneKey) => dropped.push(paneKey))
    const identities = server.getStatusSnapshot().map((entry) => ({
      paneKey: entry.paneKey,
      receivedAt: entry.receivedAt,
      stateStartedAt: entry.stateStartedAt
    }))

    const evicted = server.dropPersistedStatusEntries([
      ...identities,
      // A stale identity never matches and never blocks the rest of the batch.
      { ...identities[0]!, stateStartedAt: identities[0]!.stateStartedAt + 1 }
    ])

    expect(evicted.sort()).toEqual([PANE, otherPane].sort())
    expect(dropped.sort()).toEqual([PANE, otherPane].sort())
    expect(listener).toHaveBeenCalledTimes(1)
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('notifies pane-status-clear listener when pane teardown evicts a cached status', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setPaneStatusClearListener(listener)

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', agentType: 'claude' }
      },
      'conn-1'
    )
    server.clearPaneState(PANE)
    server.clearPaneState(PANE)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ paneKey: PANE })
  })

  it('batches connection cleanup and retains sibling and local statuses', () => {
    const server = new AgentHookServer()
    const paneKeyAt = (prefix: string, index: number): string =>
      makePaneKey(
        `${prefix}-tab-${index}`,
        `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`
      )
    const targetPaneKeys = Array.from({ length: 100 }, (_, index) => paneKeyAt('target', index))
    const siblingPaneKeys = Array.from({ length: 100 }, (_, index) =>
      paneKeyAt('sibling', index + 100)
    )
    const unstampedPaneKey = paneKeyAt('legacy', 250)
    const statusListener = vi.fn()
    const clearListener = vi.fn()
    const internals = server as unknown as AgentHookServerCacheInternals
    const persistSpy = vi.spyOn(internals, 'scheduleStatusPersist')
    server.subscribeStatusChanges(statusListener)
    server.setPaneStatusClearListener(clearListener)
    for (const paneKey of targetPaneKeys) {
      server.ingestRemote({ paneKey, payload: { state: 'working', agentType: 'claude' } }, 'ssh-a')
    }
    for (const paneKey of siblingPaneKeys) {
      server.ingestRemote({ paneKey, payload: { state: 'working', agentType: 'claude' } }, 'ssh-b')
    }
    server.ingestTerminalStatus({
      paneKey: unstampedPaneKey,
      payload: { state: 'working', prompt: '', agentType: 'codex' }
    })
    statusListener.mockClear()
    persistSpy.mockClear()

    server.clearStatusEntriesForConnection('ssh-a')

    expect(statusListener).toHaveBeenCalledOnce()
    expect(persistSpy).toHaveBeenCalledOnce()
    expect(clearListener).toHaveBeenCalledOnce()
    expect(clearListener).toHaveBeenCalledWith({
      transient: true,
      connectionId: 'ssh-a',
      clearedAt: expect.any(Number)
    })
    expect(server.getStatusSnapshot().map((entry) => entry.paneKey)).toEqual([
      ...siblingPaneKeys,
      unstampedPaneKey
    ])
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
