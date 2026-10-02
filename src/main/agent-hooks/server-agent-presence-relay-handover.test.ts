import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
)
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

const servers: { stop(): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stop()
  }
  probe.mockReset()
  probe.mockResolvedValue('live')
})
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

class Desktop extends AgentHookServer {
  hook(overrides: Partial<AgentHookEventPayload>): void {
    const event: AgentHookEventPayload = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'folder-1',
      connectionId: null,
      source: 'claude',
      hookEventName: 'PreToolUse',
      payload: { agentType: 'claude', state: 'working', prompt: 'p' },
      ...overrides
    }
    const enriched = this.applyNormalizedStatus(event)
    if (enriched) {
      this.checkAgentPresenceAfterHook(event, enriched)
    }
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function relayRig(dir: string) {
  const forwarded: AgentHookRelayEnvelope[] = []
  const relay = new RelayAgentHookServer({ endpointDir: dir, forward: (e) => forwarded.push(e) })
  const desktop = new Desktop()
  servers.push(relay, desktop)
  await relay.start()
  const { port, token } = relay.getCoordinates()
  const post = async (event: string, session: string, pid: number, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agentProcess: JSON.stringify({ pid, platform: process.platform, startTime: `b-${pid}` }),
        payload: {
          hook_event_name: event,
          session_id: session,
          source: 'startup',
          prompt: 'x',
          ...extra
        }
      })
    })
    expect(response.status).toBe(204)
  }
  const sent: AgentHookRelayEnvelope[] = []
  const pump = (): void => {
    for (const envelope of forwarded.splice(0)) {
      sent.push(envelope)
      desktop.ingestRemote(envelope, 'ssh-1')
    }
  }
  return { desktop, post, pump, sent }
}

describe('owner handover across execution hosts', () => {
  it('hands a relay pane to the Claude that replaced a silently dead one, with no exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owner-handover-'))
    const forwarded: AgentHookRelayEnvelope[] = []
    const relay = new RelayAgentHookServer({ endpointDir: dir, forward: (e) => forwarded.push(e) })
    const desktop = new Desktop()
    servers.push(relay, desktop)
    const desktopEvents: { paneKey: string; state?: string; presence?: AgentProcessPresence }[] = []
    desktop.subscribeEnrichedStatus((row) =>
      desktopEvents.push({
        paneKey: row.paneKey,
        state: row.payload.state,
        presence: row.agentPresence
      })
    )
    const released: unknown[] = []
    desktop.setAgentPresenceReleaseListener((r) => released.push(r))
    try {
      await relay.start()
      const { port, token } = relay.getCoordinates()
      const post = async (event: string, session: string, pid: number) => {
        const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
          body: JSON.stringify({
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agentProcess: JSON.stringify({
              pid,
              platform: process.platform,
              startTime: `b-${pid}`
            }),
            payload: { hook_event_name: event, session_id: session, source: 'startup', prompt: 'x' }
          })
        })
        expect(response.status).toBe(204)
      }
      const pump = (): void => {
        for (const envelope of forwarded.splice(0)) {
          desktop.ingestRemote(envelope, 'ssh-1')
        }
      }
      // Old Claude A (4001) works; then dies silently (kill -9 / crash, no SessionEnd).
      await post('UserPromptSubmit', 'a', 4001)
      pump()
      // User starts Claude B (4005) in the same remote pane.
      let finishProbe!: (verdict: 'exited') => void
      probe.mockImplementation(() => new Promise((resolve) => (finishProbe = resolve)))
      // The new Claude keeps reporting while the relay probes the old one.
      await post('UserPromptSubmit', 'b', 4005)
      await post('PreToolUse', 'b', 4005)
      await post('PostToolUse', 'b', 4005)
      finishProbe('exited')
      await flush()
      await flush()
      pump()
      const snapshot = desktop.getStatusSnapshot().find((r) => r.paneKey === PANE)
      expect(desktopEvents.some((e) => e.presence?.ended)).toBe(false)
      // The dead owner is released, never reported as an exit, and the new Claude owns the pane.
      expect(released).toEqual([{ paneKey: PANE, process: expect.objectContaining({ pid: 4001 }) }])
      expect(snapshot?.providerSessionOnly).toBeUndefined()
      expect(snapshot?.agentPresence?.process?.pid).toBe(4005)
      expect(probe).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('probes a live owner once however many nested hooks doubt it', async () => {
    const desktop = new Desktop()
    servers.push(desktop)
    const outer = {
      agent: 'claude',
      process: { pid: 4001, platform: 'linux', startTime: 'boot:1' }
    } satisfies AgentProcessPresence
    const nested = {
      agent: 'claude',
      process: { pid: 4002, platform: 'linux', startTime: 'boot:2' }
    } satisfies AgentProcessPresence
    desktop.hook({ agentPresence: outer, hookEventName: 'UserPromptSubmit' })
    const resolvers: ((v: 'live') => void)[] = []
    probe.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
    for (let i = 0; i < 10; i += 1) {
      desktop.hook({ agentPresence: nested, hookEventName: i % 2 ? 'PostToolUse' : 'PreToolUse' })
    }
    for (const r of resolvers) {
      r('live')
    }
    await flush()
    expect(desktop.getStatusSnapshot()[0]?.agentPresence).toEqual(outer)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it.each(['UserPromptSubmit', 'Stop'])(
    'restates the successor on a relay handover instead of applying its %s twice',
    async (lastHook) => {
      const dir = await mkdtemp(join(tmpdir(), 'owner-handover-'))
      try {
        const { desktop, post, pump, sent } = await relayRig(dir)
        await post('UserPromptSubmit', 'a', 4001)
        pump()
        let finishProbe!: (verdict: 'exited') => void
        probe.mockImplementation(() => new Promise((resolve) => (finishProbe = resolve)))
        await post('UserPromptSubmit', 'b', 4005)
        if (lastHook === 'Stop') {
          await post('Stop', 'b', 4005, { last_assistant_message: 'done!' })
        }
        pump()
        const before = desktop.getStatusSnapshot()[0]
        const restated: { state: string; stateStartedAt: number; isReplay?: boolean }[] = []
        desktop.subscribeEnrichedStatus((row) =>
          restated.push({
            state: row.payload.state,
            stateStartedAt: row.stateStartedAt,
            isReplay: row.isReplay
          })
        )
        await wait(20)
        finishProbe('exited')
        await flush()
        await flush()
        pump()
        const after = desktop.getStatusSnapshot()[0]
        expect(after?.agentPresence?.process?.pid).toBe(4005)
        expect(after?.turnStartedAt).toBe(before?.turnStartedAt)
        expect(after?.stateStartedAt).toBe(before?.stateStartedAt)
        // The new owner is published once, as a restatement of the same turn: no new turn, no new
        // done identity, so no second completion anywhere downstream.
        expect(restated).toEqual([
          { state: before?.state, stateStartedAt: before?.stateStartedAt, isReplay: true }
        ])
        expect(sent.at(-1)?.isReplay).toBe(true)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it('hands a dead owner to the first process that doubted it, on both hosts', async () => {
    const desktop = new Desktop()
    servers.push(desktop)
    const a = {
      agent: 'claude',
      process: { pid: 4001, platform: 'linux', startTime: 'boot:1' }
    } satisfies AgentProcessPresence
    const b = {
      agent: 'claude',
      process: { pid: 4005, platform: 'linux', startTime: 'boot:5' }
    } satisfies AgentProcessPresence
    const nested = {
      agent: 'claude',
      process: { pid: 4009, platform: 'linux', startTime: 'boot:9' }
    } satisfies AgentProcessPresence
    desktop.hook({ agentPresence: a, hookEventName: 'UserPromptSubmit' })
    let finishProbe!: (verdict: 'exited') => void
    probe.mockImplementation(() => new Promise((resolve) => (finishProbe = resolve)))
    desktop.hook({ agentPresence: b, hookEventName: 'SessionStart' })
    desktop.hook({ agentPresence: nested, hookEventName: 'PreToolUse' })
    finishProbe('exited')
    await flush()
    expect(desktop.getStatusSnapshot()[0]?.agentPresence).toEqual(b)

    const dir = await mkdtemp(join(tmpdir(), 'owner-handover-'))
    try {
      const rig = await relayRig(dir)
      await rig.post('UserPromptSubmit', 'a', 4001)
      rig.pump()
      probe.mockImplementation(() => new Promise((resolve) => (finishProbe = resolve)))
      await rig.post('SessionStart', 'b', 4005)
      await rig.post('PreToolUse', 'nested', 4009)
      finishProbe('exited')
      await flush()
      await flush()
      rig.pump()
      expect(rig.desktop.getStatusSnapshot()[0]?.agentPresence?.process?.pid).toBe(4005)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
