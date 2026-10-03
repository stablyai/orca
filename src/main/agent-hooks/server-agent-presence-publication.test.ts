import { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'
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

class PublicationServer extends AgentHookServer {
  serializedStatus(): string {
    return this.serializeStatusFile()
  }

  publish(overrides: Partial<AgentHookEventPayload> = {}): void {
    const event: AgentHookEventPayload = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'folder-1',
      connectionId: null,
      source: 'claude',
      hookEventName: 'SessionStart',
      agentPresence: owner,
      payload: { agentType: 'claude', state: 'done', prompt: '' },
      ...overrides
    }
    if (event.connectionId) {
      this.applyNormalizedStatus({ ...event, agentPresenceFromExecutionHost: true })
    } else if (event.agentPresence?.ended) {
      this.reconcileEndedProcessForPaneKeys([event.paneKey], {
        kind: 'owner-exited',
        presence: event.agentPresence
      })
    } else {
      if (event.agentPresence) {
        this.ingestForegroundPresence(event, event.agentPresence)
      }
      this.applyNormalizedStatus(event)
    }
  }
}

const servers: PublicationServer[] = []
function createServer(): PublicationServer {
  const server = new PublicationServer()
  servers.push(server)
  return server
}
afterEach(() => {
  vi.mocked(probeAgentProcessPresence).mockReset().mockResolvedValue('live')
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

describe('desktop owner publication', () => {
  it('does not check a replacement on behalf of a stale desktop owner', async () => {
    const server = createServer()
    server.publish()
    await expect(
      server.checkAgentPresence(PANE, { ...owner.process, startTime: 'older:birth' })
    ).resolves.toBe('unverifiable')
  })

  it('returns the already-published exit for the exact desktop owner', async () => {
    const server = createServer()
    server.publish()
    server.publish({ agentPresence: { ...owner, ended: true } })
    await expect(server.checkAgentPresence(PANE, owner.process)).resolves.toBe('exited')
  })
  it('carries the same idle owner in window publications and snapshots, never in turn taps', () => {
    const server = createServer()
    const window = vi.fn()
    const turns = vi.fn()
    server.setListener(window)
    server.subscribeEnrichedStatus(turns)
    server.publish()
    expect(window).toHaveBeenLastCalledWith(expect.objectContaining({ agentPresence: owner }))
    expect(turns).toHaveBeenLastCalledWith(expect.not.objectContaining({ agentPresence: owner }))
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE, agentPresence: owner })
    ])
  })

  it.each([false, true])('publishes exit before a shell prompt, resume metadata=%s', (resume) => {
    const server = createServer()
    server.publish(resume ? { providerSession: { key: 'session_id', id: 'session-a' } } : {})
    const owners = vi.fn()
    server.setAgentOwnerListener(owners)
    server.publish({ hookEventName: 'SessionEnd', agentPresence: { ...owner, ended: true } })
    expect(owners).toHaveBeenLastCalledWith(
      expect.objectContaining({ paneKey: PANE, presence: { ...owner, ended: true } })
    )
    expect(server.getStatusSnapshot()).toEqual(
      resume
        ? [
            expect.objectContaining({
              providerSessionOnly: true,
              agentPresence: { ...owner, ended: true }
            })
          ]
        : []
    )
    expect(server.getStatusChangeSnapshot()).toEqual([])
  })

  it('keeps dismissal distinct from process death, including without resume metadata', () => {
    const server = createServer()
    server.publish()
    server.dropStatusEntry(PANE)
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getAgentOwner(PANE)?.presence).toEqual(owner)
    expect(server.hasVerifiableAgentProcess(PANE)).toBe(true)
    expect(server.getStatusChangeSnapshot()).toEqual([])
  })

  it('replaces an ended owner with a new process and rejects the old exit', () => {
    const server = createServer()
    server.publish()
    server.publish({ agentPresence: { ...owner, ended: true } })
    const replacement = {
      agent: 'claude',
      process: { pid: 4002, platform: 'linux', startTime: 'boot:456' }
    } as const
    server.publish({ agentPresence: replacement })
    server.publish({ agentPresence: { ...owner, ended: true } })
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ agentPresence: replacement })
    ])
  })

  it('keeps a dismissed process owner when a nested agent reports', async () => {
    const server = createServer()
    server.publish()
    server.dropStatusEntry(PANE)
    server.publish({
      agentPresence: {
        agent: 'codex',
        process: { pid: 4002, platform: 'linux', startTime: 'boot:456' }
      },
      payload: { agentType: 'codex', state: 'done', prompt: '' }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(server.getStatusSnapshot()).toEqual([expect.objectContaining({ agentPresence: owner })])
  })

  it.each([false, true])('never persists an owner, ended=%s', (ended) => {
    const server = createServer()
    server.publish({ providerSession: { key: 'session_id', id: 'session-a' } })
    if (ended) {
      server.publish({ agentPresence: { ...owner, ended: true } })
    }
    const file = JSON.parse(server.serializedStatus())
    expect(file.entries[PANE]).toBeDefined()
    expect(file.entries[PANE]).not.toHaveProperty('agentPresence')
  })

  it('can still check the recorded owner after an unverified cleanup without guessing process death', async () => {
    const server = createServer()
    server.publish()
    server.clearPaneState(PANE, 'unverified')
    vi.mocked(probeAgentProcessPresence).mockResolvedValueOnce('exited')
    await expect(server.checkAgentPresence(PANE, owner.process)).resolves.toBe('exited')
    expect(server.getAgentOwner(PANE)?.presence).toEqual({ ...owner, ended: true })
  })

  it.each([false, true])(
    'preserves the owner through alias and cache cleanup, ended=%s',
    (ended) => {
      const server = createServer()
      server.registerPaneKeyAlias('tab-1:0', PANE, 'pty-1')
      server.publish()
      server.publish({ agentPresence: ended ? { ...owner, ended: true } : owner })
      server.clearPaneKeyAliasesForPty('pty-1', 'unverified')
      server.clearPaneState(PANE, 'unverified')
      expect(server.getAgentOwner(PANE)?.presence).toEqual(
        ended ? { ...owner, ended: true } : owner
      )
      expect(server.getStatusChangeSnapshot()).toEqual([])
    }
  )

  it('keeps one owner after disconnects and deletes it when a never-returning pane is retired', () => {
    const server = createServer()
    server.publish({ connectionId: 'ssh-a' })
    for (let i = 0; i < 3; i++) {
      // What clearPtyOwnershipForConnection -> clearProviderPtyState passes for a lost transport.
      server.clearPaneState(PANE, 'unverified')
      expect(server.getAgentOwners()).toHaveLength(1)
      expect(JSON.parse(server.serializedStatus()).entries).toEqual({})
    }
    expect(server.getStatusChangeSnapshot()).toEqual([])
    server.retirePaneAuthority(PANE)
    expect(server.getAgentOwners()).toEqual([])
  })

  it('deletes an ended owner on explicit tab close', () => {
    const server = createServer()
    server.publish()
    server.publish({ agentPresence: { ...owner, ended: true } })
    server.clearPaneState(PANE, 'unverified')
    server.dropStatusEntriesByTabPrefix('tab-1')
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getAgentOwners()).toEqual([])
  })
  it('releases an owner kept by earlier provider cleanup when its terminal exits', () => {
    const server = createServer()
    server.publish()
    server.clearPaneState(PANE, 'unverified')
    server.reconcileEndedProcessForPaneKeys([PANE], { kind: 'terminal-ended' })
    expect(server.getAgentOwners()).toEqual([])
    expect(JSON.parse(server.serializedStatus()).entries).toEqual({})
  })
})
