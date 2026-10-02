// The captured Claude cancels (see server-claude-cancel-captures.test.ts) replayed on an SSH pane:
// the hooks go through a real relay-side listener, which owns the provider records, and reach the
// desktop only as relayed payloads. The relay never learns of the cancel the desktop infers from
// Ctrl+C, so everything it restates afterwards still says the main agent is working.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import {
  cancelLabelled,
  hookAt,
  loadCapture,
  type CapturedHook
} from './claude-cancel-capture.test-fixture'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const temporaryPaths: string[] = []
const running: { stop: () => void }[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function temporaryDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

type SshPane = {
  relay: RelayAgentHookServer
  /** The desktop the relay forwards to; a desktop restart swaps it. */
  desktop: AgentHookServer
  post: (payload: Record<string, unknown>) => Promise<void>
}

function createRelay(forwardTo: () => AgentHookServer): RelayAgentHookServer {
  return new RelayAgentHookServer({
    endpointDir: temporaryDir('orca-relayed-cancel-'),
    token: 'relayed-cancel-token',
    forward: (envelope) => forwardTo().ingestRemote(envelope, 'conn-1')
  })
}

async function startSshPane(desktop: AgentHookServer): Promise<SshPane> {
  const pane: SshPane = {
    desktop,
    relay: createRelay(() => pane.desktop),
    post: async (payload) => {
      const { port, token } = pane.relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }
  }
  running.push(pane.relay, desktop)
  await pane.relay.start({ publishEndpoint: false })
  return pane
}

/** The relay process restarts (upgrade, crash) with fresh listener state; the remote agent keeps running. */
async function restartRelay(pane: SshPane): Promise<void> {
  pane.relay.stop()
  pane.relay = createRelay(() => pane.desktop)
  running.push(pane.relay)
  await pane.relay.start({ publishEndpoint: false })
}

async function postCaptured(pane: SshPane, hooks: CapturedHook[]): Promise<void> {
  for (const hook of hooks) {
    await pane.post(hook.payload)
  }
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

function pressCtrlC(server: AgentHookServer): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'claude',
    intent: 'ctrl-c'
  })
}

describe('a relayed Claude cancel with a live subagent (captured)', () => {
  const records = loadCapture('claude-cancel-subagent-hooks')
  const upToCancel = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => hookAt(records, index))
  const subagentStop = (index: number): Record<string, unknown> => ({
    ...hookAt(records, index).payload,
    hook_event_name: 'SubagentStop',
    tool_name: undefined,
    tool_input: undefined
  })

  it("keeps the cancel when the child's next hook restates the relay's working main agent", async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    expect(pressCtrlC(pane.desktop)).toBe(true)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })

    // The child's tool activity after the cancel: the relay's record still has the main agent working.
    const childTool = hookAt(records, 9)
    expect(childTool.payload.agent_id).toBeDefined()
    await pane.post(childTool.payload)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    // Both children finish on the remote; with nothing left running the cancelled row settles.
    await pane.post(subagentStop(4))
    await pane.post(subagentStop(9))
    expect(row(pane.desktop)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    expect(row(pane.desktop).subagents).toBeUndefined()
  })

  it("keeps the cancel through a child's permission prompt and its approval", async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    expect(pressCtrlC(pane.desktop)).toBe(true)

    const childTool = hookAt(records, 6).payload
    await pane.post({ ...childTool, hook_event_name: 'PermissionRequest' })
    expect(row(pane.desktop)).toMatchObject({
      state: 'waiting',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    await pane.post(childTool)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it("keeps the cancel while a child's permission card stays up over its next tool", async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    expect(pressCtrlC(pane.desktop)).toBe(true)

    const childTool = hookAt(records, 6).payload
    await pane.post({ ...childTool, hook_event_name: 'PermissionRequest' })
    // A denied request runs no tool; the child moves on to a different one, and the card stays up.
    await pane.post({ ...childTool, tool_use_id: 'toolu_after_denial' })
    expect(row(pane.desktop)).toMatchObject({
      state: 'waiting',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    await pane.post(subagentStop(4))
    expect(row(pane.desktop)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('keeps the cancel through a reconnect replay of the relay cache', async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    expect(pressCtrlC(pane.desktop)).toBe(true)

    expect(pane.relay.replayCachedPayloadsForPanes()).toBe(1)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })
  })

  it("keeps the cancel when a restarted relay's first hook is the child's", async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    expect(pressCtrlC(pane.desktop)).toBe(true)

    // Why: the restarted relay has no prompt cache or main agent record, so the child's hook arrives with an empty prompt.
    await restartRelay(pane)
    await pane.post(hookAt(records, 9).payload)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    await pane.post(subagentStop(4))
    await pane.post(subagentStop(9))
    expect(row(pane.desktop)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('releases the cancel on a replayed child hook whose prompt the desktop missed', async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(pane, upToCancel)
    const desktop = pane.desktop
    expect(pressCtrlC(desktop)).toBe(true)

    // The link drops: the next prompt and the child's hook reach only the relay.
    pane.desktop = new AgentHookServer()
    running.push(pane.desktop)
    await pane.post(hookAt(records, 10).payload)
    await pane.post(hookAt(records, 9).payload)
    pane.desktop = desktop
    expect(pane.relay.replayCachedPayloadsForPanes()).toBe(1)
    expect(row(desktop)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(row(desktop).mainAgent).not.toHaveProperty('outcome')
  })

  it('does not read a restart-seeded local roster for a relayed pane', async () => {
    const userDataPath = temporaryDir('orca-relayed-cancel-restart-')
    const firstDesktop = new AgentHookServer()
    await firstDesktop.start({ env: 'production', userDataPath })
    const pane = await startSshPane(firstDesktop)
    // The main agent Stops with the child running, and the desktop restarts.
    await postCaptured(
      pane,
      [0, 1, 2, 3, 4, 5].map((index) => hookAt(records, index))
    )
    expect(row(firstDesktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })
    firstDesktop.flushStatusPersistSync()
    firstDesktop.stop()

    const desktop = new AgentHookServer()
    await desktop.start({ env: 'production', userDataPath })
    pane.desktop = desktop
    running.push(desktop)
    // Hydration seeds the desktop's own roster from the saved row, relayed or not.
    expect(desktop._getStateForTests().claudeSubagentRosterByPaneKey.has(PANE)).toBe(true)

    // The child finishes on the remote, then a new turn starts and is cancelled.
    await pane.post(subagentStop(4))
    expect(row(desktop)).toMatchObject({ state: 'done' })
    await pane.post(hookAt(records, 7).payload)
    expect(row(desktop)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(pressCtrlC(desktop)).toBe(true)

    // Why: nothing runs on the remote; the desktop's seed is not the relay's roster.
    expect(row(desktop)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})

describe('a relayed Claude cancel with a background shell (captured)', () => {
  const records = loadCapture('claude-cancel-shell-hooks')

  it('holds the cancel through a replay and releases it at the next prompt', async () => {
    const pane = await startSshPane(new AgentHookServer())
    await postCaptured(
      pane,
      [0, 1, 2, 3, 4, 5, 6].map((index) => hookAt(records, index))
    )
    expect(pressCtrlC(pane.desktop)).toBe(true)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    expect(pane.relay.replayCachedPayloadsForPanes()).toBe(1)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    // Why: a new turn is the main agent's own fact again; the held verdict must not outlive it.
    await pane.post(hookAt(records, 7).payload)
    expect(row(pane.desktop)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    await pane.post(hookAt(records, 8).payload)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    expect(row(pane.desktop).mainAgent).not.toHaveProperty('outcome')
  })
})

it("keeps the cancel when a teammate's idle hook arrives after the late-hook window", async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_790_000_000_000)
  try {
    const pane = await startSshPane(new AgentHookServer())
    await pane.post({ hook_event_name: 'SessionStart', source: 'startup' })
    await pane.post({ hook_event_name: 'UserPromptSubmit', prompt: 'coordinate the team' })
    await pane.post({
      hook_event_name: 'SubagentStart',
      agent_id: 'areviewer-6d3cb5b52120b7bf',
      agent_type: 'reviewer'
    })
    await pane.post({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 45' },
      tool_use_id: 'toolu_1'
    })
    vi.setSystemTime(Date.now() + 2_000)
    expect(pressCtrlC(pane.desktop)).toBe(true)

    // Why: TeammateIdle names its child by `teammate_name` only, so it carries no agent id.
    vi.setSystemTime(Date.now() + 20_000)
    await pane.post({ hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' })
    expect(row(pane.desktop)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  } finally {
    vi.useRealTimers()
  }
})

it('keeps a relayed waiting child visible when the main agent is cancelled', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  try {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: {
          state: 'working',
          prompt: 'coordinate reviewers',
          agentType: 'claude',
          mainAgent: { state: 'working', stateStartedAt: 900 },
          subagents: [{ id: 'reviewer-1', state: 'waiting', startedAt: 900 }]
        }
      },
      'conn-1'
    )
    const baseline = row(server)

    vi.setSystemTime(1_500)
    expect(
      server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: baseline.prompt,
        baselineAgentType: 'claude',
        intent: 'ctrl-c'
      })
    ).toBe(true)
    expect(row(server)).toMatchObject({
      state: 'waiting',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [{ id: 'reviewer-1', state: 'waiting' }]
    })
  } finally {
    vi.useRealTimers()
  }
})

describe('a relayed idle-prompt Ctrl+C that killed a background agent (captured)', () => {
  const records = loadCapture('claude-idle-ctrl-c-bg-agent-hooks')
  const scan = records.find((record) => record.kind === 'transcript')
  const killedLine = scan?.kind === 'transcript' ? scan.agents_killed_records[0] : undefined
  if (!killedLine) {
    throw new Error('the capture has no agents_killed line')
  }
  // JSON.parse returns any; the timestamp read below is checked by Date.parse.
  const killed: Record<string, unknown> = JSON.parse(killedLine)
  const killedAt = Date.parse(String(killed.timestamp))
  // The capture's t=0 on the wall clock: the line is stamped within ~20 ms of the keypress.
  const t0 = killedAt - cancelLabelled(records, 'CTRL-C-idle-with-bg-shell-and-bg-agent').t * 1000

  beforeEach(() => {
    // Why: the relay's roster stamps a child's start with Date.now(); poll ticks stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function transcriptFile(): string {
    const path = join(temporaryDir('orca-relayed-agents-killed-'), 'session.jsonl')
    writeFileSync(path, '')
    return path
  }

  async function replay(
    pane: SshPane,
    transcript: string,
    indices: number[],
    override: Record<string, unknown> = {}
  ): Promise<void> {
    for (const index of indices) {
      const hook = hookAt(records, index)
      vi.setSystemTime(t0 + hook.t * 1000)
      await pane.post({ ...hook.payload, transcript_path: transcript, ...override })
    }
  }

  async function kill(pane: SshPane, transcript: string): Promise<void> {
    vi.setSystemTime(killedAt + 120)
    appendFileSync(transcript, `${killedLine}\n`)
    await vi.waitFor(
      () =>
        expect(row(pane.desktop).subagents?.some((child) => child.state === 'working')).not.toBe(
          true
        ),
      { timeout: 3_000 }
    )
  }

  it("retires the child on the relay, so a reconnect replay can't restore it", async () => {
    const pane = await startSshPane(new AgentHookServer())
    const transcript = transcriptFile()
    await replay(pane, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })

    // The session runs on the remote host, so its relay listener is the one watching.
    await kill(pane, transcript)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' },
      lastAssistantMessage: 'STARTED'
    })
    expect(row(pane.desktop).subagents).toBeUndefined()
    expect(row(pane.desktop).interrupted).toBeUndefined()
    expect(row(pane.desktop).mainAgent).not.toHaveProperty('outcome')

    expect(pane.relay.replayCachedPayloadsForPanes()).toBe(1)
    expect(row(pane.desktop).subagents).toBeUndefined()

    await replay(pane, transcript, [11, 12])
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    expect(row(pane.desktop).subagents).toBeUndefined()
  })

  it('parks a killed teammate-shaped child idle, as its own SubagentStop would', async () => {
    const pane = await startSshPane(new AgentHookServer())
    const transcript = transcriptFile()
    await replay(pane, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // A teammate joins after the Stop's inventory (whose fold would otherwise reap the id).
    await replay(pane, transcript, [8], { agent_id: 'aprobe1-6d3cb5b5', agent_type: 'probe1' })
    expect(row(pane.desktop).subagents).toHaveLength(2)

    await kill(pane, transcript)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      subagents: [expect.objectContaining({ id: 'aprobe1-6d3cb5b5', state: 'idle' })],
      mainAgent: { state: 'done' }
    })
  })

  it("keeps the desktop's inferred mid-turn cancel when the relay retires the child", async () => {
    const pane = await startSshPane(new AgentHookServer())
    const transcript = transcriptFile()
    // Ctrl+C while the second turn runs cancels it (no hook) and leaves the agent running; the
    // relay never learns of the cancel, so its main agent record still says working.
    await replay(pane, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(pressCtrlC(pane.desktop)).toBe(true)
    expect(row(pane.desktop)).toMatchObject({
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })

    // The idle Ctrl+C that follows kills the agent. The relay's row is the child's own stop,
    // so the desktop re-folds it under the cancel instead of taking its working main agent.
    await kill(pane, transcript)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    expect(row(pane.desktop).subagents).toBeUndefined()
  })

  it('restores no killed child when the desktop restarts', async () => {
    const userDataPath = temporaryDir('orca-relayed-agents-killed-restart-')
    const firstDesktop = new AgentHookServer()
    await firstDesktop.start({ env: 'production', userDataPath })
    const pane = await startSshPane(firstDesktop)
    const transcript = transcriptFile()
    await replay(pane, transcript, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    await kill(pane, transcript)
    firstDesktop.flushStatusPersistSync()
    firstDesktop.stop()

    const desktop = new AgentHookServer()
    await desktop.start({ env: 'production', userDataPath })
    pane.desktop = desktop
    running.push(desktop)
    expect(desktop._getStateForTests().claudeSubagentRosterByPaneKey.has(PANE)).toBe(false)
    expect(row(desktop)).toMatchObject({ workingMode: 'monitoring', mainAgent: { state: 'done' } })
    expect(row(desktop).subagents).toBeUndefined()
  })
})
