import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { projectPluginAgentStatusChangedPayload } from '../plugins/plugin-agent-status-event'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'exited' | 'unverifiable'> => 'unverifiable')
)
const suspended = vi.hoisted(() => vi.fn(async (): Promise<boolean> => false))
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe,
  isSuspendedAgentProcess: suspended
}))
const owner = {
  agent: 'codex',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const
const successor = {
  agent: 'claude',
  process: { pid: 43, platform: 'linux', startTime: 'boot:43' }
} as const
const scope = { paneKey: PANE, connectionId: null, tabId: 'tab-1', worktreeId: 'folder-1' }
class Host extends AgentHookServer {
  serialized(): unknown {
    return JSON.parse(this.serializeStatusFile())
  }
  turn(event: Partial<AgentHookEventPayload> = {}) {
    const payload: AgentHookEventPayload = {
      ...scope,
      source: 'codex',
      hookEventName: 'UserPromptSubmit',
      payload: { agentType: 'codex', state: 'waiting', prompt: 'Approve?' },
      ...event
    }
    this.recordCurrentAuthorityObservation(payload)
    this.applyNormalizedStatus(payload)
  }
  alias(legacy: string, stable: string): void {
    this.legacyPaneKeyAliases.set(legacy, {
      stablePaneKey: stable,
      ptyId: 'pty-1',
      updatedAt: Date.now(),
      authorityVerified: true
    })
  }
}
const hosts: Host[] = []
function host() {
  const result = new Host()
  hosts.push(result)
  return result
}
afterEach(() => {
  hosts.splice(0).forEach((server) => server.stop())
  vi.useRealTimers()
  probe.mockReset()
  probe.mockResolvedValue('unverifiable')
  suspended.mockReset()
  suspended.mockResolvedValue(false)
})

describe('host foreground ownership', () => {
  it('keeps a permission turn and its evidence clock; turn subscribers never see the owner', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const server = host()
    server.turn()
    const before = server.getStatusSnapshot()[0]
    const published = vi.fn()
    server.subscribeEnrichedStatus(published)
    vi.setSystemTime(5_000)
    server.ingestForegroundPresence(scope, owner)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'waiting',
      prompt: 'Approve?',
      agentPresence: owner,
      evidenceObservedAt: before.evidenceObservedAt,
      stateStartedAt: before.stateStartedAt,
      receivedAt: before.receivedAt
    })
    expect(server.getStatusSnapshot()[0].providerSessionOnly).not.toBe(true)
    expect(published).not.toHaveBeenCalled()
  })

  it('records a hookless owner without minting a turn, and plugins hear nothing', () => {
    const server = host()
    const plugin = vi.fn()
    server.subscribeEnrichedStatus((enriched) => {
      const payload = projectPluginAgentStatusChangedPayload(enriched)
      if (payload) {
        plugin(payload)
      }
    })
    const changes = vi.fn()
    server.subscribeStatusChanges(changes)
    server.ingestForegroundPresence(scope, owner)
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getAgentOwner(PANE)).toMatchObject({ paneKey: PANE, presence: owner })
    expect(plugin).not.toHaveBeenCalled()
    expect(changes).toHaveBeenCalledWith([])
    expect(server.serialized()).toMatchObject({ entries: {} })
  })

  it('keeps the owner when its turn is dismissed', () => {
    const server = host()
    server.turn()
    server.ingestForegroundPresence(scope, owner)
    server.dropStatusEntry(PANE)
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getAgentOwner(PANE)?.presence).toEqual(owner)
  })

  it('keeps Pi resume identity whichever of discovery and session_start comes first', () => {
    const session = {
      key: 'session_id',
      id: 'pi-session-1',
      transcriptPath: '/tmp/pi/session-1.jsonl'
    } as const
    for (const discoveryFirst of [true, false]) {
      const server = host()
      const sessionStart = () =>
        server.turn({
          source: 'pi',
          hookEventName: 'session_start',
          providerSession: session,
          providerSessionOnly: true,
          payload: { agentType: 'pi', state: 'done', prompt: '' }
        })
      if (discoveryFirst) {
        server.ingestForegroundPresence(scope, { ...owner, agent: 'pi' })
        sessionStart()
      } else {
        sessionStart()
        server.ingestForegroundPresence(scope, { ...owner, agent: 'pi' })
      }
      expect(server.getProviderSessionIdentities()).toEqual([
        expect.objectContaining({ paneKey: PANE, sessionId: 'pi-session-1' })
      ])
      expect(server.getAgentOwner(PANE)?.presence.agent).toBe('pi')
    }
  })

  it('admits an owner seen under a legacy alias on its stable pane, so it can be checked', async () => {
    const server = host()
    server.alias('tab-1:1', PANE)
    server.ingestForegroundPresence({ ...scope, paneKey: 'tab-1:1' }, owner)
    expect(server.getAgentOwner(PANE)?.presence).toEqual(owner)
    expect(server.hasVerifiableAgentProcess('tab-1:1')).toBe(true)
    probe.mockResolvedValue('exited')
    expect(await server.checkAgentPresence('tab-1:1')).toBe('exited')
    expect(server.getAgentOwner(PANE)?.presence.ended).toBe(true)
  })

  it('replaces a stopped owner with the agent now in front, never a running one', async () => {
    const server = host()
    server.ingestForegroundPresence(scope, owner)
    await server.ingestForegroundPresence(scope, successor)
    expect(server.getAgentOwner(PANE)?.presence).toEqual(owner)
    suspended.mockResolvedValue(true)
    const released = vi.fn()
    server.setAgentPresenceReleaseListener(released)
    await server.ingestForegroundPresence(scope, successor)
    expect(suspended).toHaveBeenLastCalledWith(owner.process)
    expect(server.getAgentOwner(PANE)?.presence).toEqual(successor)
    expect(released).toHaveBeenCalledWith({ paneKey: PANE, process: owner.process })
  })

  it('releases an owner that has no turn when its terminal ends', () => {
    const server = host()
    const released = vi.fn()
    server.setAgentPresenceReleaseListener(released)
    server.ingestForegroundPresence(scope, owner)
    expect(server.reconcileEndedProcessForPaneKeys([PANE], { kind: 'terminal-ended' })).toBe(1)
    expect(server.getAgentOwner(PANE)).toBeUndefined()
    expect(released).toHaveBeenCalledWith({ paneKey: PANE, process: owner.process })
  })

  it('keeps an unknown owner on command-authority revocation and clears only proven exit', async () => {
    const server = host()
    server.ingestForegroundPresence(scope, owner)
    server.retirePaneAuthority(PANE, undefined, { authorityOnly: true })
    expect(await server.checkAgentPresence(PANE)).toBe('unverifiable')
    expect(server.getAgentOwner(PANE)?.presence).toEqual(owner)
    probe.mockResolvedValue('exited')
    expect(await server.checkAgentPresence(PANE)).toBe('exited')
    expect(server.getAgentOwner(PANE)?.presence.ended).toBe(true)
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('revokes launch authority without losing the owner or persisting a stale token', () => {
    const server = host()
    const token = 'old-launch'
    let launchTokenHash: string | null = createHash('sha256').update(token).digest('hex')
    server.setPaneLaunchAuthorityReader(() => ({ launchTokenHash }))
    server.turn({ launchToken: token })
    server.ingestForegroundPresence(scope, owner)
    expect(server.getCurrentAuthorityObservations()).toHaveLength(1)
    launchTokenHash = null
    server.retirePaneAuthority(PANE, undefined, { authorityOnly: true })
    server.turn({ launchToken: token })
    expect(server.getCurrentAuthorityObservations()).toEqual([])
    expect(server.getStatusSnapshot()[0]?.agentPresence).toEqual(owner)
    expect(server.serialized()).not.toHaveProperty(`entries.${PANE}.launchTokenHash`)
    expect(server.serialized()).not.toHaveProperty(`entries.${PANE}.agentPresence`)
    expect(server.serialized()).not.toHaveProperty(`authorityCommitments.${PANE}`)
  })

  it('never reads a plain shell and settles silent death by the owner-only clock', async () => {
    vi.useFakeTimers()
    const server = host()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).not.toHaveBeenCalled()
    server.ingestForegroundPresence(scope, owner)
    probe.mockResolvedValue('exited')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(probe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(probe).toHaveBeenCalledExactlyOnceWith(owner.process)
    expect(server.getAgentOwner(PANE)?.presence.ended).toBe(true)
  })

  it('does not let a late capture resurrect a closed pane', () => {
    const server = host()
    server.retirePaneAuthority(PANE)
    server.ingestForegroundPresence(scope, owner)
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getAgentOwner(PANE)).toBeUndefined()
  })

  it('drops an exited owner once a later live turn arrives, so it never labels that turn', async () => {
    const server = host()
    const released = vi.fn()
    server.setAgentPresenceReleaseListener(released)
    server.ingestForegroundPresence(scope, owner)
    probe.mockResolvedValue('exited')
    expect(await server.checkAgentPresence(PANE)).toBe('exited')
    server.turn({
      source: 'claude',
      hookEventName: 'UserPromptSubmit',
      isReplay: true,
      payload: { agentType: 'codex', state: 'working', prompt: 'replayed' }
    })
    expect(server.getAgentOwner(PANE)?.presence.ended).toBe(true)
    server.turn({
      source: 'claude',
      hookEventName: 'UserPromptSubmit',
      payload: { agentType: 'claude', state: 'working', prompt: 'second agent' }
    })
    expect(server.getAgentOwner(PANE)).toBeUndefined()
    expect(server.getStatusSnapshot()[0]).toMatchObject({ prompt: 'second agent' })
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('agentPresence')
    expect(released).toHaveBeenCalledWith({ paneKey: PANE, process: owner.process })
  })

  it('lets legacy shell evidence settle a later turn despite an exited owner', async () => {
    const server = host()
    server.ingestForegroundPresence(scope, owner)
    probe.mockResolvedValue('exited')
    await server.checkAgentPresence(PANE)
    server.turn({ isReplay: true })
    expect(
      server.reconcileEndedProcessForPaneKeys([PANE], { kind: 'legacy-shell-foreground' })
    ).toBe(1)
  })
})
