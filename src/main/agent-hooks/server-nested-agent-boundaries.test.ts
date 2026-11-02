import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

class ClockedHookServer extends AgentHookServer {
  advanceConnectionClock(at: number): void {
    this.connectionTimestampWatermarkById.set('conn-1', at)
  }
}

const route = { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('nested provider ownership boundaries', () => {
  it.each([
    ['ssh-b', 'wt-1', 'codex'],
    ['conn-1', 'wt-2', 'codex'],
    ['conn-1', 'wt-1', 'claude']
  ] as const)(
    'scopes ownership to host %s and workspace %s',
    (connectionId, worktreeId, agentType) => {
      const server = new AgentHookServer()
      server.ingestRemote(
        { ...route, payload: { state: 'working', prompt: 'Parent', agentType: 'claude' } },
        'conn-1'
      )
      server.ingestRemote(
        {
          ...route,
          worktreeId,
          payload: { state: 'working', prompt: 'Other', agentType: 'codex' }
        },
        connectionId
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({ agentType, connectionId, worktreeId })
    }
  )

  it.each([
    [null, 'wsl:Ubuntu'],
    ['wsl:Ubuntu', null]
  ] as const)('retains WSL ownership across %s to %s transport', (before, after) => {
    const server = new AgentHookServer()
    const worktreeId = 'repo:://wsl.localhost/Ubuntu/home/user/project'
    server.ingestRemote(
      {
        ...route,
        worktreeId,
        payload: { state: 'working', prompt: 'Parent', agentType: 'claude' }
      },
      before
    )
    server.ingestRemote(
      { ...route, worktreeId, payload: { state: 'working', prompt: 'Nested', agentType: 'codex' } },
      after
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({ agentType: 'claude', prompt: 'Parent' })
  })

  it('admits a local HTTP owner despite a remote pane-key collision', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      server.ingestRemote(
        { ...route, payload: { state: 'working', prompt: 'Remote', agentType: 'claude' } },
        'ssh-a'
      )
      const response = await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'local-codex',
          prompt: 'Local'
        }),
        '/hook/codex'
      )
      expect(response.status).toBe(204)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        connectionId: null,
        agentType: 'codex',
        prompt: 'Local',
        providerSession: { id: 'local-codex' }
      })
    } finally {
      server.stop()
    }
  })

  it('uses the retained connection clock to allow a stale provider replacement after rollback', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const server = new ClockedHookServer()
    server.ingestRemote(
      { ...route, payload: { state: 'working', prompt: 'Old work', agentType: 'claude' } },
      'conn-1'
    )
    const future = 1_000 + AGENT_STATUS_STALE_AFTER_MS + 100
    server.advanceConnectionClock(future)
    vi.setSystemTime(500)
    server.ingestRemote(
      { ...route, payload: { state: 'working', prompt: 'New work', agentType: 'codex' } },
      'conn-1'
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      agentType: 'codex',
      prompt: 'New work',
      receivedAt: future + 1
    })
  })

  it('keeps nested Pi identity-only metadata off an active owner and permits it after completion', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        ...route,
        payload: { state: 'working', prompt: 'Parent work', agentType: 'claude' },
        providerSession: { key: 'session_id', id: 'claude-parent' }
      },
      'conn-1'
    )
    const before = server.getStatusSnapshot()
    const pi = {
      ...route,
      providerSessionOnly: true,
      providerSession: {
        key: 'session_id' as const,
        id: 'pi-child',
        transcriptPath: '/tmp/pi-child.jsonl'
      },
      payload: { state: 'done' as const, prompt: '', agentType: 'pi' as const }
    }
    server.ingestRemote(pi, 'conn-1')
    expect(server.getStatusSnapshot()).toEqual(before)
    server.ingestRemote(
      { ...route, payload: { state: 'done', prompt: 'Parent work', agentType: 'claude' } },
      'conn-1'
    )
    server.ingestRemote(pi, 'conn-1')
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      agentType: 'pi',
      providerSessionOnly: true,
      providerSession: { id: 'pi-child' }
    })
  })
})
