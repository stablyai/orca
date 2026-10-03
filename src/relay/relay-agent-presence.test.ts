import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as RetrySchedulerModule from './agent-hook-result-retry-scheduler'
import type { AgentHookResultRetryHost } from './agent-hook-result-retry-scheduler'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'

const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'unverifiable')
)
vi.mock('../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
const retryHosts = vi.hoisted(() => {
  const hosts: AgentHookResultRetryHost[] = []
  return hosts
})
vi.mock('./agent-hook-result-retry-scheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof RetrySchedulerModule>()
  return {
    AgentHookResultRetryScheduler: class extends actual.AgentHookResultRetryScheduler {
      constructor(host: AgentHookResultRetryHost) {
        super(host)
        retryHosts.push(host)
      }
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  retryHosts.length = 0
  probe.mockReset()
  probe.mockResolvedValue('unverifiable')
})

const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

describe('relay process presence', () => {
  it('registers hookless discovery with the shared two-second owner check', async () => {
    vi.useFakeTimers()
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: '/unused-hook-endpoint', forward })
    const owner = {
      agent: 'codex',
      process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
    } as const
    try {
      await vi.advanceTimersByTimeAsync(6_000)
      expect(probe).not.toHaveBeenCalled()
      server.ingestForegroundPresence({ paneKey, tabId: 'tab-1', worktreeId: 'folder' }, owner)
      probe.mockResolvedValue('exited')
      await vi.advanceTimersByTimeAsync(1_999)
      expect(probe).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(probe).toHaveBeenCalledExactlyOnceWith(owner.process)
      expect(forward.mock.lastCall?.[0]).toMatchObject({
        providerSessionOnly: true,
        agentPresence: { ...owner, ended: true }
      })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(probe).toHaveBeenCalledTimes(1)
    } finally {
      server.stop()
    }
  })

  it('keeps unavailable reads, preserves resume, and publishes a real exit without a window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-presence-'))
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    try {
      await server.start()
      const { port, token } = server.getCoordinates()
      const post = async (event: string, session: string, reason?: string, pid = 4001) => {
        const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
          body: JSON.stringify({
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agentProcess: JSON.stringify({
              pid,
              platform: process.platform,
              startTime: `birth-${pid}`
            }),
            payload: { hook_event_name: event, session_id: session, source: 'startup', reason }
          })
        })
        expect(response.status).toBe(204)
      }
      await post('SessionStart', 'a')
      server.ingestForegroundPresence(
        { paneKey, tabId: 'tab-1', worktreeId: 'wt-1' },
        { agent: 'claude', process: { pid: 4001, platform: 'linux', startTime: 'birth-4001' } }
      )
      expect(forward.mock.lastCall?.[0].agentPresence?.process?.pid).toBe(4001)
      expect(probe).not.toHaveBeenCalled()
      const retryHost = retryHosts[0]
      const original = retryHost.state.lastStatusByPaneKey.get(paneKey)
      if (!original) {
        throw new Error('missing hook status')
      }
      retryHost.applyEvent(
        { ...original, payload: { ...original.payload, lastAssistantMessage: 'late result' } },
        'claude'
      )
      await Promise.resolve()
      expect(forward.mock.lastCall?.[0].payload.lastAssistantMessage).toBe('late result')
      expect(probe).not.toHaveBeenCalled()

      await server.checkAgentPresence(paneKey)
      expect(forward.mock.lastCall?.[0].agentPresence?.ended).toBeUndefined()
      await post('SessionEnd', 'a', 'resume')
      await post('SessionStart', 'b')
      await post('SessionEnd', 'nested', 'other', 4002)
      expect(forward.mock.lastCall?.[0].agentPresence?.ended).toBeUndefined()
      const forwardedBeforeExit = forward.mock.calls.length
      await post('SessionEnd', 'b', 'prompt_input_exit')
      // The exit hook carries no turn; the relay's exact check (its 2 s beat) proves the exit.
      expect(forward.mock.calls.length).toBe(forwardedBeforeExit)
      probe.mockResolvedValueOnce('exited')
      await server.checkAgentPresence(paneKey)
      expect(forward.mock.lastCall?.[0].agentPresence?.ended).toBe(true)
      expect(forward.mock.lastCall?.[0].providerSessionOnly).toBe(true)
      await post('SessionStart', 'c', undefined, 4003)
      server.ingestForegroundPresence(
        { paneKey, tabId: 'tab-1', worktreeId: 'wt-1' },
        { agent: 'claude', process: { pid: 4003, platform: 'linux', startTime: 'birth-4003' } }
      )
      expect(forward.mock.lastCall?.[0].agentPresence?.process?.pid).toBe(4003)
      probe.mockResolvedValue('exited')
      await server.checkAgentPresence(paneKey)
      expect(forward.mock.lastCall?.[0].agentPresence?.ended).toBe(true)
      expect(forward.mock.lastCall?.[0].providerSessionOnly).toBe(true)
    } finally {
      server.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
