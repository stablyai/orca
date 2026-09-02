import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, recentTs, PANE, GOOD_PANE } from './server.test-fixtures'

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

describe('Last-status persistence', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-laststatus-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function lastStatusPath(): string {
    return join(userDataPath, 'agent-hooks', 'last-status.json')
  }

  it('lets an identical live OSC observation confirm a hydrated row', async () => {
    const payload = {
      state: 'working' as const,
      prompt: 'still running',
      agentType: 'claude' as const
    }
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    firstServer.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload
    })
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const restored = server.getStatusSnapshot()[0]
      if (!restored) {
        throw new Error('expected hydrated status')
      }
      expect(restored?.restoredUnconfirmed).toBe(true)
      vi.spyOn(Date, 'now').mockReturnValue(restored.receivedAt - 1_000)
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        payload
      })
      const confirmed = server.getStatusSnapshot()[0]
      expect(confirmed?.restoredUnconfirmed).toBeUndefined()
      expect(confirmed?.receivedAt).toBe(restored.receivedAt + 1)
    } finally {
      server.stop()
    }
  })

  it('does not let a hydrated Claude permission suppress the first live working event', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    firstServer.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hookEventName: 'PermissionRequest',
        payload: {
          state: 'waiting',
          prompt: 'review command',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'dangerous command'
        }
      },
      'conn-1'
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'PreToolUse',
          payload: {
            state: 'working',
            prompt: 'review command',
            agentType: 'claude',
            toolName: 'Read',
            toolInput: 'package.json'
          }
        },
        'conn-1'
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        toolName: 'Read'
      })
      expect(server.getStatusSnapshot()[0]?.restoredUnconfirmed).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('does not inherit a stale tool id from hydrated Claude progress', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    firstServer.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hookEventName: 'PreToolUse',
        toolUseId: 'tool-old',
        toolAgentType: 'main',
        payload: {
          state: 'working',
          prompt: 'run tests',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'pnpm test'
        }
      },
      'conn-1'
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'PermissionRequest',
          toolAgentType: 'main',
          payload: {
            state: 'waiting',
            prompt: 'run tests',
            agentType: 'claude',
            toolName: 'Bash',
            toolInput: 'pnpm test'
          }
        },
        'conn-1'
      )
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'PostToolUse',
          toolUseId: 'tool-new',
          toolAgentType: 'main',
          payload: {
            state: 'working',
            prompt: 'run tests',
            agentType: 'claude',
            toolName: 'Bash',
            toolInput: 'pnpm test'
          }
        },
        'conn-1'
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
    } finally {
      server.stop()
    }
  })

  it('never persists the unconfirmed flag and re-stamps it on every hydrate', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    firstServer.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'still running', agentType: 'claude' }
      },
      'conn-1'
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const secondServer = new AgentHookServer()
    await secondServer.start({ env: 'production', userDataPath })
    secondServer.flushStatusPersistSync()
    secondServer.stop()
    expect(readFileSync(lastStatusPath(), 'utf8')).not.toContain('restoredUnconfirmed')

    const thirdServer = new AgentHookServer()
    await thirdServer.start({ env: 'production', userDataPath })
    try {
      expect(thirdServer.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', restoredUnconfirmed: true })
      ])
    } finally {
      thirdServer.stop()
    }
  })

  it('refuses interrupt inference on an unconfirmed hydrated row', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    firstServer.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'long task', agentType: 'codex' }
      },
      'conn-1'
    )
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const baseline = server.getStatusSnapshot()[0]
      expect(baseline).toMatchObject({ paneKey: PANE, restoredUnconfirmed: true })
      const applied = server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: 'long task',
        baselineAgentType: 'codex',
        intent: 'plain-escape'
      })
      // Why: synthesizing `done` onto a never-confirmed `working` would fabricate a transition from stale disk state.
      expect(applied).toBe(false)
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
      expect(server.getStatusSnapshot()[0]?.interrupted).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('keeps SSH status ordering monotonic across hydration and clock rollback', async () => {
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const receivedAt = now + 1_000
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [PANE]: {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            connectionId: 'ssh-a',
            receivedAt,
            stateStartedAt: receivedAt,
            payload: { state: 'working', prompt: 'before restart', agentType: 'claude' }
          }
        }
      }),
      'utf8'
    )

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const clearListener = vi.fn()
      server.setPaneStatusClearListener(clearListener)
      server.ingestRemote(
        { paneKey: PANE, payload: { state: 'working', agentType: 'codex' } },
        'ssh-a'
      )

      expect(server.getStatusSnapshot()[0]?.receivedAt).toBe(receivedAt + 1)
      server.clearStatusEntriesForConnection('ssh-a')
      const clearedAt = receivedAt + 2
      expect(clearListener).toHaveBeenCalledWith({
        transient: true,
        connectionId: 'ssh-a',
        clearedAt
      })
      server.ingestRemote(
        {
          paneKey: GOOD_PANE,
          isReplay: true,
          payload: { state: 'working', agentType: 'claude' }
        },
        'ssh-a'
      )
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: GOOD_PANE,
          connectionId: 'ssh-a',
          receivedAt: clearedAt + 1
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('drops persisted idle Claude child rows from hydration replay', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const receivedAt = recentTs()
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [PANE]: {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            receivedAt,
            stateStartedAt: recentTs(-1000),
            payload: {
              state: 'done',
              prompt: 'finished orchestration',
              agentType: 'claude',
              subagents: [
                { id: 'aweb-research-8a76b7d7', state: 'idle', startedAt: receivedAt - 5000 },
                { id: 'apr-history-9b87c6e6', state: 'idle', startedAt: receivedAt - 4000 }
              ]
            }
          }
        }
      }),
      'utf8'
    )

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ subagents: undefined })
        })
      )
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'done',
          prompt: 'finished orchestration',
          subagents: undefined
        })
      ])
      // Why: migration must be one-time, else every launch re-prunes the same persisted idle rows.
      const persisted = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
      expect(persisted.entries[PANE].payload.subagents).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('restores Codex child hierarchy and reaps unconfirmed children on the next root Stop', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    const receivedAt = recentTs()
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [PANE]: {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            receivedAt,
            stateStartedAt: recentTs(-1000),
            payload: {
              state: 'working',
              prompt: 'coordinate reviews',
              agentType: 'codex',
              model: 'gpt-5.4',
              subagents: [
                {
                  id: '11111111-2222-4333-8444-555555555555',
                  state: 'working',
                  startedAt: receivedAt - 5000,
                  agentType: 'reviewer',
                  model: 'gpt-5.4-mini'
                }
              ]
            }
          }
        }
      }),
      'utf8'
    )

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          model: 'gpt-5.4',
          subagents: [
            expect.objectContaining({
              id: '11111111-2222-4333-8444-555555555555',
              model: 'gpt-5.4-mini'
            })
          ]
        })
      ])

      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'PreToolUse',
          agent_id: '11111111-2222-4333-8444-555555555555',
          agent_type: 'reviewer',
          model: 'gpt-5.4-mini',
          tool_name: 'exec_command',
          tool_input: { cmd: 'pnpm test' }
        }),
        '/hook/codex'
      )
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          model: 'gpt-5.4',
          subagents: [expect.objectContaining({ model: 'gpt-5.4-mini' })]
        })
      ])

      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'Stop', model: 'gpt-5.4' }),
        '/hook/codex'
      )
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ state: 'done', model: 'gpt-5.4', subagents: undefined })
      ])
    } finally {
      server.stop()
    }
  })
})
