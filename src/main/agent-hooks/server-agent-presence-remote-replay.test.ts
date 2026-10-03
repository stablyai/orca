import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transitionHookPresence } from '../../shared/agent-hook-presence-transition'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import type { AgentProcessIdentity } from '../../shared/agent-process-presence'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
)
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe,
  isSuspendedAgentProcess: vi.fn(async () => false)
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const owner = {
  agent: 'claude',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const
const replacement = {
  agent: 'claude',
  process: { pid: 43, platform: 'linux', startTime: 'boot:43' }
} as const
const servers: { stop(): void }[] = []
const dirs: string[] = []
afterEach(() => {
  servers.splice(0).forEach((server) => server.stop())
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  probe.mockResolvedValue('live')
})
function claudeHook(
  event: string,
  session: string,
  agentProcess: AgentProcessIdentity,
  extra: Record<string, unknown> = {}
) {
  return buildBody(
    { hook_event_name: event, session_id: session, source: 'startup', ...extra },
    { worktreeId: 'folder-1', agentProcess: JSON.stringify(agentProcess) }
  )
}
class InspectableServer extends AgentHookServer {
  storedRow(paneKey: string) {
    return this.state.lastStatusByPaneKey.get(paneKey)
  }
}
async function setup() {
  let connected = true
  const main = new InspectableServer()
  const frames: AgentHookRelayEnvelope[] = []
  const dir = mkdtempSync(join(tmpdir(), 'remote-replay-'))
  dirs.push(dir)
  const relay = new RelayAgentHookServer({
    endpointDir: dir,
    forward: (event) => {
      frames.push(event)
      if (connected) {
        main.ingestRemote(event, 'ssh-1')
      }
    }
  })
  servers.push(main, relay)
  await relay.start()
  const request = { paneKey: PANE, tabId: 'tab-1', worktreeId: 'folder-1' }
  const relayHook = async (...args: Parameters<typeof claudeHook>) => {
    const { port, token } = relay.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify(claudeHook(...args))
    })
    expect(response.status).toBe(204)
  }
  const capture = (process: AgentProcessIdentity) =>
    relay.ingestForegroundPresence(request, { agent: 'claude', process })
  return {
    main,
    capture,
    relay,
    relayHook,
    request,
    frames,
    connect: (value: boolean) => {
      connected = value
    }
  }
}
describe('execution host presence replay', () => {
  it.each([false, true])(
    'converges after offline exit and replacement (replacement ended=%s)',
    async (ended) => {
      const { main, capture, relay, relayHook, frames, connect } = await setup()
      await relayHook('SessionStart', 'a', owner.process)
      capture(owner.process)
      connect(false)
      probe.mockResolvedValue('exited')
      await relay.checkAgentPresence(PANE)
      const staleExit = frames.at(-1)!
      await relayHook('SessionStart', 'b', replacement.process)
      capture(replacement.process)
      if (ended) {
        await relay.checkAgentPresence(PANE)
      } else {
        probe.mockResolvedValue('live')
      }
      connect(true)
      relay.replayCachedPayloadsForPanes()
      await relay.checkAgentPresence(PANE)
      expect(main.getStatusSnapshot()[0]?.agentPresence).toMatchObject({
        ...replacement,
        ...(ended ? { ended: true } : {})
      })
      main.ingestRemote(staleExit, 'ssh-1')
      main.ingestRemote({ ...frames[0], isReplay: true }, 'ssh-1')
      main.ingestRemote({ ...staleExit, isReplay: true }, 'ssh-1')
      expect(main.getStatusSnapshot()[0]?.agentPresence?.process).toEqual(replacement.process)
      expect(main.getStatusSnapshot()[0]?.agentPresence?.ended).toBe(ended ? true : undefined)
    }
  )
  it('shows the replacement when the old owner was waiting on permission at disconnect', async () => {
    const { main, capture, relay, relayHook, connect } = await setup()
    await relayHook('SessionStart', 'a', owner.process)
    capture(owner.process)
    await relayHook('PermissionRequest', 'a', owner.process, { tool_name: 'Bash' })
    expect(main.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting' })
    connect(false)
    main.clearStatusEntriesForConnection('ssh-1')
    probe.mockResolvedValue('exited')
    await relay.checkAgentPresence(PANE)
    probe.mockResolvedValue('live')
    await relayHook('SessionStart', 'b', replacement.process)
    capture(replacement.process)
    await relayHook('PreToolUse', 'b', replacement.process, { tool_name: 'Read' })
    connect(true)
    relay.replayCachedPayloadsForPanes()
    // The dead owner's permission prompt must not hold the new agent's turn.
    expect(main.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      agentPresence: replacement
    })
  })
  it('keeps host provenance off the stored row', async () => {
    const { main, capture, relayHook } = await setup()
    await relayHook('SessionStart', 'a', owner.process)
    capture(owner.process)
    expect(main.getAgentOwner(PANE)?.presence).toMatchObject(owner)
    expect(main.storedRow(PANE)).not.toHaveProperty('agentPresence')
    expect(main.storedRow(PANE)).not.toHaveProperty('agentPresenceFromExecutionHost')
  })
  it('keeps a later unidentified row when the old owner exit replays', async () => {
    const { main, capture, relay, relayHook, frames, connect } = await setup()
    await relayHook('SessionStart', 'a', owner.process)
    capture(owner.process)
    probe.mockResolvedValue('exited')
    await relay.checkAgentPresence(PANE)
    // A later agent in the same pane reports only through terminal bytes (no process identity).
    main.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'folder-1',
      connectionId: 'ssh-1',
      payload: { state: 'working', prompt: 'fix the build', agentType: 'codex' }
    })
    connect(false)
    relay.replayCachedPayloadsForPanes()
    main.ingestRemote(frames.at(-1)!, 'ssh-1')
    expect(main.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      agentType: 'codex',
      prompt: 'fix the build'
    })
  })
  it('retains the ordering of a connected exit when an older live frame replays', async () => {
    const { main, capture, relay, relayHook, frames } = await setup()
    await relayHook('SessionStart', 'a', owner.process)
    capture(owner.process)
    const staleLive = frames.at(-1)!
    probe.mockResolvedValue('exited')
    await relay.checkAgentPresence(PANE)
    const exited = main.getAgentOwner(PANE)?.presence
    main.ingestRemote({ ...staleLive, isReplay: true }, 'ssh-1')
    expect(main.getAgentOwner(PANE)?.presence).toEqual(exited)
    expect(exited?.ended).toBe(true)
  })
  it('does not accept host provenance from local hook or terminal bytes', async () => {
    const { main, request } = await setup()
    await main.start({ env: 'production' })
    await postHookEvent(main, claudeHook('SessionStart', 'a', owner.process))
    main.ingestForegroundPresence({ ...request, connectionId: null }, owner)
    const normalized = normalizeHookPayload(
      createHookListenerState(),
      'claude',
      {
        env: 'production',
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        agentProcess: { ...replacement.process, observation: { epoch: 'fake', sequence: 99 } },
        agentPresenceFromExecutionHost: true,
        agentPresenceObservation: { epoch: 'fake', sequence: 99 },
        payload: { hook_event_name: 'SessionStart', session_id: 'nested', source: 'startup' }
      },
      'production'
    )
    expect(normalized?.agentPresenceFromExecutionHost).toBeUndefined()
    expect(normalized).not.toBeNull()
    expect(normalized?.agentPresence?.observation).toBeUndefined()
    if (!normalized) {
      throw new Error('missing normalized hook')
    }
    expect(
      transitionHookPresence(normalized, { ...normalized, agentPresence: owner })?.agentPresence
    ).toEqual(owner)
    const bytes = {
      ...request,
      ptyId: 'pty',
      terminalHandle: 'terminal',
      agentPresence: replacement,
      agentPresenceFromExecutionHost: true,
      agentPresenceObservation: { epoch: 'fake', sequence: 99 },
      payload: { agentType: 'codex', state: 'done' as const, prompt: '' }
    }
    main.ingestTerminalStatus(bytes)
    expect(main.getStatusSnapshot()[0]?.agentPresence).toEqual(owner)
  })
  it('keeps mismatched exits from an old relay on the exact-owner fence', async () => {
    const { main, request } = await setup()
    const event = {
      ...request,
      source: 'claude',
      payload: { state: 'done', prompt: '', agentType: 'claude' },
      agentPresence: { ...owner, observation: { epoch: 'host', sequence: 1 } }
    }
    main.ingestRemote(event, 'ssh-1')
    const mismatchedExit = { ...event, agentPresence: { ...replacement, ended: true } } as const
    main.ingestRemote(mismatchedExit, 'ssh-1')
    main.ingestRemote({ ...mismatchedExit, isReplay: true }, 'ssh-1')
    expect(main.getStatusSnapshot()[0]?.agentPresence).toMatchObject(owner)
  })
  // Version adapter: an older relay still forwards Claude's hook-claimed exit, unstamped.
  it('lets an old relay exit clear the turn it names, never mint one or end a host owner', () => {
    const main = new InspectableServer()
    servers.push(main)
    const turn = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'folder-1',
      source: 'claude',
      providerSession: { key: 'session_id', id: 'session-a' },
      hookEventName: 'Stop',
      payload: { state: 'done', prompt: 'task', agentType: 'claude' }
    }
    const legacyExit = {
      ...turn,
      hookEventName: 'SessionEnd',
      agentPresence: { ...owner, ended: true }
    }
    const live = () => main.getStatusSnapshot().filter((row) => !row.providerSessionOnly)
    main.ingestRemote(legacyExit, 'ssh-1')
    expect(main.getStatusSnapshot()).toEqual([])
    main.ingestRemote(turn, 'ssh-1')
    main.ingestRemote({ ...legacyExit, isReplay: true }, 'ssh-1')
    expect(live()).toHaveLength(1)
    main.ingestRemote(
      { ...legacyExit, providerSession: { key: 'session_id', id: 'other' } },
      'ssh-1'
    )
    expect(live()).toHaveLength(1)
    main.ingestRemote(legacyExit, 'ssh-1')
    expect(live()).toEqual([])
    main.ingestRemote(turn, 'ssh-1')
    main.ingestRemote(
      { ...turn, agentPresence: { ...owner, observation: { epoch: 'host', sequence: 1 } } },
      'ssh-1'
    )
    main.ingestRemote(legacyExit, 'ssh-1')
    expect(live()).toHaveLength(1)
    expect(main.getAgentOwner(PANE)?.presence.ended).toBeUndefined()
  })

  it('never lets an owner envelope restate a prompt into a retired pane', () => {
    const main = new InspectableServer()
    servers.push(main)
    main.retirePaneAuthority(PANE)
    main.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        hasExplicitPrompt: true,
        providerSessionOnly: true,
        agentPresence: { ...owner, observation: { epoch: 'host', sequence: 1 } },
        payload: { state: 'working', prompt: 'old prompt', agentType: 'claude' }
      },
      'ssh-1'
    )
    expect(main.getStatusSnapshot()).toEqual([])
    expect(main.getAgentOwner(PANE)).toBeUndefined()
  })
})
