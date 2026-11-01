import captures from '../../shared/agent-hook-listener/__fixtures__/declined-permission-hooks.json'
// Replay captured SSH permission hooks; single-row relay caching can hide the resolving event during disconnect.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import { hookAt, loadCapture } from './claude-cancel-capture.test-fixture'
import { CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS } from '../../shared/claude-owed-task-notifications'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const records = loadCapture('claude-permission-approve-deny-hooks')
const prompt = hookAt(records, 0).payload
const firstTool = hookAt(records, 1).payload
const firstPermission = hookAt(records, 2).payload
const firstNotification = hookAt(records, 3).payload
const firstToolDone = hookAt(records, 4).payload
const secondTool = hookAt(records, 5).payload

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

type SshPane = {
  relay: RelayAgentHookServer
  desktop: AgentHookServer
  /** Stands in for a receiver built before the projection: it never reads the fields that receiver lacks. */
  legacy?: AgentHookServer
  connected: boolean
  forwarded: AgentHookRelayEnvelope[]
  post: (payload: Record<string, unknown>) => Promise<void>
  /** A fresh relay process has an empty producer table, as after a host restart with the CLI still running. */
  restartCold: () => Promise<void>
}

function withoutProjection(envelope: AgentHookRelayEnvelope): AgentHookRelayEnvelope {
  const { claudePermissionState: _projection, claudeSettledRequests, ...legacy } = envelope
  return envelope.isReplay ? { ...legacy, claudeSettledRequests } : legacy
}

async function startRelay(
  forward: (envelope: AgentHookRelayEnvelope) => void
): Promise<RelayAgentHookServer> {
  const endpointDir = mkdtempSync(join(tmpdir(), 'orca-relayed-permission-'))
  temporaryPaths.push(endpointDir)
  const relay = new RelayAgentHookServer({
    endpointDir,
    token: 'relayed-permission-token',
    forward
  })
  running.push(relay)
  await relay.start({ publishEndpoint: false })
  return relay
}

async function startSshPane(): Promise<SshPane> {
  const forward = (envelope: AgentHookRelayEnvelope): void => {
    pane.forwarded.push(envelope)
    if (pane.connected) {
      pane.desktop.ingestRemote(envelope, 'conn-1')
      pane.legacy?.ingestRemote(withoutProjection(envelope), 'conn-1')
    }
  }
  const pane: SshPane = {
    relay: await startRelay(forward),
    desktop: new AgentHookServer(),
    connected: true,
    forwarded: [],
    post: async (payload) => {
      const { port, token } = pane.relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    },
    restartCold: async () => {
      pane.relay.stop()
      pane.relay = await startRelay(forward)
    }
  }
  running.push(pane.desktop)
  return pane
}

async function postAll(pane: SshPane, payloads: Record<string, unknown>[]): Promise<void> {
  for (const payload of payloads) {
    await pane.post(payload)
  }
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

async function waitingOnFirstRequest(): Promise<SshPane> {
  const pane = await startSshPane()
  await postAll(pane, [prompt, firstTool, firstPermission, firstNotification])
  expect(row(pane.desktop)).toMatchObject({ state: 'waiting', toolName: 'Bash' })
  return pane
}

function reconnect(pane: SshPane): void {
  pane.connected = true
  pane.relay.replayCachedPayloadsForPanes()
}

describe('a relayed Claude permission wait across a reconnect (captured)', () => {
  it('clears live when the approved request ends while connected', async () => {
    const pane = await waitingOnFirstRequest()
    await postAll(pane, [firstToolDone, secondTool])
    expect(row(pane.desktop)).toMatchObject({ state: 'working' })
  })

  it('clears on reconnect when the request ended while the desktop was away', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    await postAll(pane, [firstToolDone, secondTool])
    reconnect(pane)

    expect(row(pane.desktop)).toMatchObject({ state: 'working', toolName: 'Bash' })
    expect(row(pane.desktop).toolInput).toContain('second-file.txt')
    const replay = pane.forwarded.at(-1)
    expect(replay).toMatchObject({
      isReplay: true,
      hookEventName: 'PreToolUse',
      claudeSettledRequests: [{ toolUseId: firstToolDone.tool_use_id }]
    })
  })

  it('keeps the wait when the request the desktop shows has not ended', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    // A different tool's activity is not evidence that the pending request was answered.
    await postAll(pane, [
      { ...firstToolDone, tool_use_id: 'toolu_other' },
      { ...secondTool, tool_use_id: 'toolu_next' }
    ])
    reconnect(pane)

    expect(row(pane.desktop)).toMatchObject({ state: 'waiting' })
    expect(row(pane.desktop).toolInput).toContain('first-file.txt')
  })

  it('does not carry an ended request into a new Claude session', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    await pane.post(firstToolDone)
    await pane.post({ ...secondTool, session_id: '11111111-1111-4111-8111-111111111111' })
    reconnect(pane)

    expect(pane.forwarded.at(-1)?.claudeSettledRequests).toBeUndefined()
  })

  it('ignores settled requests on a live (non-replay) envelope', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    await pane.post(secondTool)
    const live = pane.forwarded.at(-1)
    expect(live?.claudePermissionState?.cause).toMatchObject({ hookEventName: 'PreToolUse' })
    expect(live?.isReplay).toBeUndefined()
    pane.connected = true
    pane.desktop.ingestRemote(
      {
        ...live,
        paneKey: PANE,
        payload: live?.payload,
        claudeSettledRequests: [{ toolUseId: String(firstTool.tool_use_id) }]
      },
      'conn-1'
    )
    expect(row(pane.desktop)).toMatchObject({ state: 'waiting' })
  })
})

describe('complete execution-host permission projections', () => {
  it('keeps the recorded parallel prompt card over live and replayed siblings, then clears after settlement history turns over', async () => {
    const pane = await startSshPane()
    const raw = captures.claudeParallel
    for (const payload of raw.slice(0, 4)) {
      await pane.post(payload)
    }
    const card = row(pane.desktop)
    pane.connected = false
    for (const payload of raw.slice(4, 10)) {
      await pane.post(payload)
    }
    reconnect(pane)
    expect(row(pane.desktop)).toMatchObject({
      state: 'waiting',
      toolName: card.toolName,
      toolInput: card.toolInput,
      interactivePrompt: card.interactivePrompt
    })
    expect(pane.forwarded.at(-1)?.claudePermissionState).toMatchObject({
      knowledge: 'complete',
      pending: { toolUseId: expect.any(String) }
    })
    pane.connected = false
    await pane.post(raw[10])
    for (let i = 0; i < 20; i++) {
      await pane.post({ ...raw[12], tool_use_id: `later-${i}` })
    }
    reconnect(pane)
    expect(pane.forwarded.at(-1)?.claudeSettledRequests).not.toContainEqual(
      expect.objectContaining({ toolUseId: raw[2].tool_use_id })
    )
    expect(pane.forwarded.at(-1)?.claudePermissionState).toEqual({
      version: 1,
      knowledge: 'complete'
    })
    expect(row(pane.desktop).state).toBe('working')
  })

  it('shows receivers built before the projection the pending request itself, so a cold producer restart keeps the wait until its approval', async () => {
    const pane = await startSshPane()
    pane.legacy = new AgentHookServer()
    running.push(pane.legacy)
    const raw = captures.claudeParallel
    await postAll(pane, raw.slice(0, 5))
    expect(pane.forwarded.at(-1)).toMatchObject({
      hookEventName: 'PermissionRequest',
      toolUseId: raw[2].tool_use_id,
      claudePermissionState: {
        cause: { hookEventName: 'PreToolUse', toolUseId: raw[4].tool_use_id }
      }
    })
    for (const receiver of [pane.desktop, pane.legacy]) {
      expect(row(receiver)).toMatchObject({ state: 'waiting', toolName: 'Read' })
    }
    await pane.restartCold()
    await pane.post(raw[5])
    for (const receiver of [pane.desktop, pane.legacy]) {
      expect(row(receiver)).toMatchObject({ state: 'waiting', toolName: 'Read' })
    }
    // Constructed approval of the recorded request; the recording itself declines it.
    await pane.post({ ...raw[2], hook_event_name: 'PostToolUse', tool_response: { file: {} } })
    for (const receiver of [pane.desktop, pane.legacy]) {
      expect(row(receiver).state).toBe('working')
    }
  })

  it('publishes a cold producer’s first recorded batch, settling the wait the receiver still shows', async () => {
    const pane = await startSshPane()
    const raw = captures.claudeDecline
    await postAll(pane, raw.slice(0, 5))
    expect(row(pane.desktop)).toMatchObject({ state: 'waiting', toolName: 'Read' })
    await pane.restartCold()
    await pane.post(raw[5])
    expect(row(pane.desktop).state).toBe('working')
    const denied = { toolUseId: raw[2].tool_use_id }
    expect(pane.forwarded.at(-1)).toMatchObject({
      hookEventName: 'PostToolBatch',
      claudePermissionState: { knowledge: 'unknown' },
      claudeSettledRequests: [denied]
    })
    pane.relay.replayCachedPayloadsForPanes()
    expect(pane.forwarded.at(-1)).toMatchObject({ isReplay: true, claudeSettledRequests: [denied] })
  })
})

describe('owed-notification restatement while a child permission is open', () => {
  const session = '11111111-1111-4111-8111-111111111111'
  const childRead = {
    tool_name: 'Read',
    tool_input: { file_path: '/outside.txt' },
    agent_id: 'a123',
    agent_type: 'general-purpose'
  }

  beforeEach(() => {
    // Why shouldAdvanceTime: the hooks are real loopback POSTs, which need the clock to move.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Constructed: child a123 asks while child b456 ends owing the idle main agent a notification.
  async function childAsksWhileAnotherOwesNotification(pane: SshPane): Promise<void> {
    const hook = (fields: Record<string, unknown>) => pane.post({ session_id: session, ...fields })
    await hook({ hook_event_name: 'SessionStart', source: 'startup' })
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'run both' })
    for (const agentId of ['a123', 'b456']) {
      await hook({
        hook_event_name: 'SubagentStart',
        agent_id: agentId,
        agent_type: 'general-purpose'
      })
      await hook({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_use_id: `launch-${agentId}`,
        tool_response: { isAsync: true, status: 'async_launched', agentId }
      })
    }
    await hook({
      hook_event_name: 'Stop',
      background_tasks: ['a123', 'b456'].map((id) => ({ id, type: 'subagent', status: 'running' }))
    })
    await hook({ hook_event_name: 'PreToolUse', ...childRead, tool_use_id: 'child-read' })
    await hook({ hook_event_name: 'PermissionRequest', ...childRead })
    await hook({ hook_event_name: 'SubagentStop', agent_id: 'b456' })
    expect(row(pane.desktop)).toMatchObject({ state: 'waiting', toolName: 'Read' })
  }

  it('restates the open request when the lease expires, so a fresh receiver still shows it', async () => {
    const pane = await startSshPane()
    await childAsksWhileAnotherOwesNotification(pane)
    const before = pane.forwarded.length
    vi.advanceTimersByTime(CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS)
    expect(pane.forwarded.length).toBeGreaterThan(before)
    const restated = pane.forwarded.at(-1)
    expect(restated).toMatchObject({
      hookEventName: 'PermissionRequest',
      toolAgentId: 'a123',
      claudePermissionState: { pending: { toolAgentId: 'a123' } },
      payload: { state: 'waiting', toolName: 'Read' }
    })
    expect(restated?.claudePermissionState?.cause).toBeDefined()
    expect(restated?.claudePermissionState?.cause?.hookEventName).toBeUndefined()
    pane.desktop = new AgentHookServer()
    running.push(pane.desktop)
    reconnect(pane)
    expect(row(pane.desktop)).toMatchObject({ state: 'waiting', toolName: 'Read' })
    await pane.post({
      session_id: session,
      hook_event_name: 'PostToolUse',
      ...childRead,
      tool_use_id: 'child-read'
    })
    expect(row(pane.desktop).state).not.toBe('waiting')
  })

  it('lets a recomputed all-clear restatement replace a held wait after settlement history turns over', async () => {
    const pane = await startSshPane()
    await childAsksWhileAnotherOwesNotification(pane)
    pane.connected = false
    const child = { session_id: session, hook_event_name: 'PostToolUse', agent_id: 'a123' }
    await pane.post({ ...child, ...childRead, tool_use_id: 'child-read' })
    for (let i = 0; i < 20; i++) {
      await pane.post({
        ...child,
        tool_name: 'Bash',
        tool_input: { command: `echo ${i}` },
        tool_use_id: `later-${i}`
      })
    }
    vi.advanceTimersByTime(CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS)
    const restated = pane.forwarded.at(-1)
    expect(restated?.hookEventName).toBeUndefined()
    expect(restated?.claudePermissionState).toEqual({ version: 1, knowledge: 'complete' })
    reconnect(pane)
    expect(pane.forwarded.at(-1)?.claudeSettledRequests).not.toContainEqual(
      expect.objectContaining({ toolUseId: 'child-read' })
    )
    expect(row(pane.desktop).state).not.toBe('waiting')
  })
})

it('invalidates complete observation after an authenticated malformed raw post while preserving the pending card', async () => {
  const pane = await startSshPane()
  for (const payload of captures.claudeParallel.slice(0, 4)) {
    await pane.post(payload)
  }
  const { port, token } = pane.relay.getCoordinates()
  await fetch(`http://127.0.0.1:${port}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': token,
      'X-Orca-Pane-Key': PANE
    },
    body: '{'
  })
  await pane.post(captures.claudeParallel[4])
  expect(pane.forwarded.at(-1)?.claudePermissionState).toMatchObject({
    knowledge: 'unknown',
    pending: { toolUseId: expect.any(String) }
  })
  expect(row(pane.desktop)).toMatchObject({ state: 'waiting', toolName: 'Read' })
  await pane.post(captures.claudeParallel[10])
  expect(row(pane.desktop).state).toBe('working')
})
