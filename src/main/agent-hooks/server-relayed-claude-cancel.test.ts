// Replay captured cancels over SSH; the relay never sees desktop Ctrl+C inference and may restate stale main-agent work.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import { hookAt, loadCapture, type CapturedHook } from './claude-cancel-capture.test-fixture'

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

/** Restart relay state while the remote agent keeps running. */
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

    // Child activity arrives while the relay still believes the main agent is working.
    const childTool = hookAt(records, 9)
    expect(childTool.payload.agent_id).toBeDefined()
    await pane.post(childTool.payload)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    // Owed child notification holds the relay row while desktop cancellation remains authoritative.
    await pane.post(subagentStop(4))
    await pane.post(subagentStop(9))
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
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
    // Denial runs no tool; unrelated child progress must not dismiss the request.
    await pane.post({ ...childTool, tool_use_id: 'toolu_after_denial' })
    expect(row(pane.desktop)).toMatchObject({
      state: 'waiting',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    // Child end dismisses its permission card while the owed notification still holds the row.
    await pane.post(subagentStop(4))
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
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

    // A restarted relay has no prompt or main-agent cache, so child hooks arrive with empty prompt.
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

    // A desktop replacement misses subsequent hooks retained only by the relay.
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
    // Restart the desktop after the main agent Stops with a live child.
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
    expect(desktop._getStateForTests().claudeSubagentRosterByPaneKey.has(PANE)).toBe(true)

    // Finish the remote child and notification turn, then cancel a new turn.
    await pane.post(subagentStop(4))
    expect(row(desktop)).toMatchObject({ state: 'working' })
    await pane.post({
      hook_event_name: 'UserPromptSubmit',
      prompt: `<task-notification>\n<task-id>${String(hookAt(records, 4).payload.agent_id)}</task-id>\n<status>completed</status>`
    })
    await pane.post({ hook_event_name: 'Stop', background_tasks: [] })
    expect(row(desktop)).toMatchObject({ state: 'done' })
    await pane.post(hookAt(records, 7).payload)
    expect(row(desktop)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(pressCtrlC(desktop)).toBe(true)

    // A desktop-restored roster cannot override current remote evidence that no work remains.
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

    // TeammateIdle identifies children only by teammate_name.
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
