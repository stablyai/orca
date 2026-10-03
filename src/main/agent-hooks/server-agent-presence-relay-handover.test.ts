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
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe,
  isSuspendedAgentProcess: vi.fn(async () => false)
}))

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

const presence = (pid: number): AgentProcessPresence => ({
  agent: 'claude',
  process: { pid, platform: 'linux', startTime: `b-${pid}` }
})
const captureLocal = (server: Desktop, pid: number) =>
  server.ingestForegroundPresence(
    { paneKey: PANE, connectionId: null, worktreeId: 'folder-1', tabId: 'tab-1' },
    presence(pid)
  )

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
  const capture = (pid: number) =>
    relay.ingestForegroundPresence(
      { paneKey: PANE, worktreeId: 'wt-1', tabId: 'tab-1' },
      presence(pid)
    )
  const postPi = async (body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${port}/hook/pi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload: body })
    })
    expect(response.status).toBe(204)
  }
  return { desktop, relay, capture, post, postPi, pump, sent }
}

describe('owner handover across execution hosts', () => {
  it('requires proven exit and foreground admission; nested hooks cannot select the successor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owner-handover-'))
    try {
      const rig = await relayRig(dir)
      await rig.post('UserPromptSubmit', 'a', 4001)
      rig.capture(4001)
      rig.pump()
      let finish!: (v: 'exited') => void
      probe.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const check = rig.relay.checkAgentPresence(PANE)
      await rig.post('UserPromptSubmit', 'b', 4005)
      await rig.post('PreToolUse', 'nested', 4009)
      rig.capture(4009)
      rig.pump()
      expect(rig.desktop.getAgentOwner(PANE)?.presence.process?.pid).toBe(4001)
      finish('exited')
      await check
      rig.pump()
      expect(rig.desktop.getAgentOwner(PANE)?.presence.ended).toBe(true)
      rig.capture(4005)
      rig.pump()
      expect(rig.desktop.getAgentOwner(PANE)?.presence.process?.pid).toBe(4005)
      expect(probe).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('coalesces idle-hook checks and ignores nested hook ownership claims', async () => {
    const desktop = new Desktop()
    servers.push(desktop)
    desktop.hook({ hookEventName: 'UserPromptSubmit' })
    captureLocal(desktop, 4001)
    let finish!: (v: 'live') => void
    probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    for (let i = 0; i < 10; i += 1) {
      desktop.hook({
        agentPresence: presence(4009),
        hookEventName: 'Stop',
        payload: { agentType: 'claude', state: 'done', prompt: 'p' }
      })
    }
    finish('live')
    await flush()
    expect(desktop.getStatusSnapshot()[0]?.agentPresence).toEqual(presence(4001))
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it.each(['UserPromptSubmit', 'Stop'])(
    'publishes discovery as identity only after %s',
    async (lastHook) => {
      const dir = await mkdtemp(join(tmpdir(), 'owner-handover-'))
      try {
        const rig = await relayRig(dir)
        await rig.post('UserPromptSubmit', 'b', 4005)
        if (lastHook === 'Stop') {
          await rig.post('Stop', 'b', 4005, { last_assistant_message: 'done!' })
        }
        rig.pump()
        const before = rig.desktop.getStatusSnapshot()[0]
        const events: { metadata?: boolean; stateStartedAt: number }[] = []
        rig.desktop.subscribeEnrichedStatus((row) =>
          events.push({
            metadata: row.providerSessionOnly,
            stateStartedAt: row.stateStartedAt
          })
        )
        rig.capture(4005)
        rig.pump()
        const after = rig.desktop.getStatusSnapshot()[0]
        expect(after?.agentPresence?.process?.pid).toBe(4005)
        expect(after?.turnStartedAt).toBe(before?.turnStartedAt)
        expect(after?.stateStartedAt).toBe(before?.stateStartedAt)
        expect(after?.state).toBe(before?.state)
        // Turn subscribers (plugins, stats, notifications) never hear an owner observation.
        expect(events).toEqual([])
        expect(rig.sent.at(-1)?.providerSessionOnly).toBe(true)
        expect(rig.sent.at(-1)?.source).toBe('claude')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it('fences a delayed exit across explicit pane release on both hosts', async () => {
    const desktop = new Desktop()
    servers.push(desktop)
    captureLocal(desktop, 4001)
    let finish!: (v: 'exited') => void
    probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const check = desktop.checkAgentPresence(PANE)
    desktop.clearPaneState(PANE, 'released')
    captureLocal(desktop, 4005)
    finish('exited')
    await check
    expect(desktop.getAgentOwner(PANE)?.presence).toEqual(presence(4005))

    const dir = await mkdtemp(join(tmpdir(), 'owner-handover-'))
    try {
      const rig = await relayRig(dir)
      rig.capture(4001)
      rig.pump()
      const pending = rig.relay.checkAgentPresence(PANE)
      rig.relay.clearPaneState(PANE)
      rig.capture(4005)
      finish('exited')
      await pending
      rig.pump()
      expect(rig.desktop.getAgentOwner(PANE)?.presence).toMatchObject(presence(4005))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sends a relay owner admission over a Pi session to the owner path only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owner-handover-'))
    try {
      const rig = await relayRig(dir)
      await rig.postPi({
        hook_event_name: 'session_start',
        session_id: 'pi-session-1',
        session_file: '/tmp/pi-session-1.jsonl'
      })
      rig.pump()
      const turns = vi.fn()
      rig.desktop.subscribeEnrichedStatus(turns)
      rig.relay.ingestForegroundPresence(
        { paneKey: PANE, worktreeId: 'wt-1', tabId: 'tab-1' },
        { agent: 'pi', process: { pid: 4100, platform: 'linux', startTime: 'b-4100' } }
      )
      rig.pump()
      expect(rig.sent.at(-1)).toMatchObject({ providerSessionOnly: true })
      expect(rig.sent.at(-1)).not.toHaveProperty('providerSession')
      expect(turns).not.toHaveBeenCalled()
      expect(rig.desktop.getAgentOwner(PANE)?.presence.process?.pid).toBe(4100)
      expect(rig.desktop.getProviderSessionIdentities()).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ends a remote turn on its exit hook when the remote host has no owner (tmux, WSL)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owner-handover-'))
    try {
      const rig = await relayRig(dir)
      await rig.post('UserPromptSubmit', 'a', 4001)
      rig.pump()
      const live = () => rig.desktop.getStatusSnapshot().filter((row) => !row.providerSessionOnly)
      expect(live()).toHaveLength(1)
      await rig.post('SessionEnd', 'nested', 4002, { reason: 'other' })
      rig.pump()
      expect(live()).toHaveLength(1)
      await rig.post('SessionEnd', 'a', 4001, { reason: 'prompt_input_exit' })
      rig.pump()
      expect(live()).toEqual([])
      expect(rig.desktop.getAgentOwner(PANE)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never replays an exited remote turn as Done after a reconnect or a desktop restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owner-handover-'))
    try {
      const rig = await relayRig(dir)
      await rig.post('UserPromptSubmit', 'a', 4001)
      await rig.post('Stop', 'a', 4001)
      rig.pump()
      const live = (server: AgentHookServer) =>
        server.getStatusSnapshot().filter((row) => !row.providerSessionOnly)
      expect(live(rig.desktop).map((row) => row.state)).toEqual(['done'])
      await rig.post('SessionEnd', 'a', 4001, { reason: 'prompt_input_exit' })
      rig.pump()
      expect(live(rig.desktop)).toEqual([])

      expect(rig.relay.replayCachedPayloadsForPanes()).toBe(1)
      rig.pump()
      expect(live(rig.desktop)).toEqual([])

      const fresh = new Desktop()
      servers.push(fresh)
      rig.relay.replayCachedPayloadsForPanes()
      const replay = rig.sent.length
      rig.pump()
      for (const envelope of rig.sent.slice(replay)) {
        fresh.ingestRemote(envelope, 'ssh-1')
      }
      expect(live(fresh)).toEqual([])
      // Resume identity survives the exit, as it does on the desktop.
      expect(rig.sent.at(-1)).toMatchObject({ providerSessionOnly: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
