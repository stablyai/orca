import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { FRESH_PANE, GOOD_PANE, PANE } from './server.test-fixtures'
import { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'
import { AGENT_OWNER_RECHECK_INTERVAL_MS } from '../../shared/agent-owner-liveness-recheck'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn(async () => 'live'),
  isSuspendedAgentProcess: vi.fn(async () => false)
}))

const owner = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'boot:123' }
} satisfies AgentProcessPresence
const sibling = {
  agent: 'claude',
  process: { pid: 4002, platform: 'linux', startTime: 'boot:456' }
} satisfies AgentProcessPresence

class RecheckServer extends AgentHookServer {
  publish(overrides: Partial<AgentHookEventPayload> = {}): void {
    const event: AgentHookEventPayload = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'folder-1',
      connectionId: null,
      source: 'claude',
      hookEventName: 'UserPromptSubmit',
      agentPresence: owner,
      payload: { agentType: 'claude', state: 'working', prompt: 'task' },
      ...overrides
    }
    if (event.agentPresence) {
      this.ingestForegroundPresence(event, event.agentPresence)
    }
    this.applyNormalizedStatus(event)
  }
}

const servers: RecheckServer[] = []
function createServer(): RecheckServer {
  const server = new RecheckServer()
  servers.push(server)
  return server
}
const probe = vi.mocked(probeAgentProcessPresence)
async function beat(times = 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(AGENT_OWNER_RECHECK_INTERVAL_MS * times)
}

beforeEach(() => {
  vi.useFakeTimers()
  probe.mockReset().mockResolvedValue('live')
})
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  vi.useRealTimers()
})

describe('host recheck of live process owners', () => {
  it('checks each live owner once per beat and never touches ownerless panes', async () => {
    const server = createServer()
    server.publish({ paneKey: GOOD_PANE, tabId: 'tab-good', agentPresence: undefined })
    await beat(3)
    expect(probe).not.toHaveBeenCalled()

    server.publish()
    server.publish({ paneKey: FRESH_PANE, tabId: 'tab-fresh', agentPresence: sibling })
    await beat(2)
    expect(probe).toHaveBeenCalledTimes(4)
    expect(probe.mock.calls.map(([identity]) => identity?.pid).sort()).toEqual([
      4001, 4001, 4002, 4002
    ])
  })

  it.each([
    ['its release', (server: RecheckServer) => server.clearPaneState(PANE, 'released')],
    ['its tab closing', (server: RecheckServer) => server.dropStatusEntriesByTabPrefix('tab-1')],
    [
      'its terminal being replaced',
      (server: RecheckServer) =>
        server.reconcileEndedProcessForPaneKeys([PANE], { kind: 'terminal-ended' })
    ],
    ['the service stopping', (server: RecheckServer) => server.stop()]
  ])('stops checking an owner after %s', async (_case, end) => {
    const server = createServer()
    server.publish()
    await beat()
    expect(probe).toHaveBeenCalledTimes(1)
    end(server)
    await beat(3)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('never ends an owner its check cannot answer for', async () => {
    const server = createServer()
    server.publish()
    probe.mockResolvedValue('unverifiable')
    await beat(5)
    expect(server.getAgentOwner(PANE)?.presence).toEqual(owner)
  })

  it('ends an owner whose process is gone and stops checking it', async () => {
    const server = createServer()
    const ended: unknown[] = []
    server.setAgentOwnerListener((event) => {
      if (event.presence.ended) {
        ended.push(event.presence)
      }
    })
    server.publish()
    probe.mockResolvedValue('exited')
    await beat()
    expect(ended).toEqual([{ ...owner, ended: true }])
    await beat(3)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
