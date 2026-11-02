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
import captures from '../../shared/agent-hook-listener/__fixtures__/declined-permission-hooks.json'

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
  connected: boolean
  forwarded: AgentHookRelayEnvelope[]
  post: (payload: Record<string, unknown>) => Promise<void>
}

async function startSshPane(): Promise<SshPane> {
  const endpointDir = mkdtempSync(join(tmpdir(), 'orca-relayed-permission-'))
  temporaryPaths.push(endpointDir)
  const pane: SshPane = {
    desktop: new AgentHookServer(),
    connected: true,
    forwarded: [],
    relay: new RelayAgentHookServer({
      endpointDir,
      token: 'relayed-permission-token',
      forward: (envelope) => {
        pane.forwarded.push(envelope)
        if (pane.connected) {
          pane.desktop.ingestRemote(envelope, 'conn-1')
        }
      }
    }),
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
  running.push(pane.relay, pane.desktop)
  await pane.relay.start({ publishEndpoint: false })
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
    expect(live).toMatchObject({ hookEventName: 'PreToolUse' })
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

const decline = captures.claudeDecline

/** The relay's own cached pane row (what it would replay), read without a production accessor. */
function relayRow(relay: RelayAgentHookServer): unknown {
  const state: unknown = Reflect.get(relay, 'state')
  const rows =
    typeof state === 'object' && state !== null
      ? Reflect.get(state, 'lastStatusByPaneKey')
      : undefined
  const get: unknown =
    typeof rows === 'object' && rows !== null ? Reflect.get(rows, 'get') : undefined
  return typeof get === 'function' ? get.call(rows, PANE) : undefined
}
const declineBatch = decline.findIndex((raw) => raw.hook_event_name === 'PostToolBatch')

/** A relay and desktop pair whose forwarding can be cut, filtered, or moved to a fresh relay process. */
async function startDeclinePair(
  filter: (envelope: AgentHookRelayEnvelope) => AgentHookRelayEnvelope | undefined = (envelope) =>
    envelope
) {
  const desktop = new AgentHookServer()
  running.push(desktop)
  const pair = {
    desktop,
    connected: true,
    forwarded: [] as AgentHookRelayEnvelope[],
    relay: undefined as unknown as RelayAgentHookServer,
    post: async (raw: Record<string, unknown>) => {
      const { port, token } = pair.relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(raw))
      })
      expect(response.status).toBe(204)
      return row(desktop).state
    },
    /** A fresh relay process: an empty producer table while the CLI keeps running. */
    restart: async () => {
      pair.relay?.stop()
      const endpointDir = mkdtempSync(join(tmpdir(), 'orca-relayed-permission-'))
      temporaryPaths.push(endpointDir)
      pair.relay = new RelayAgentHookServer({
        endpointDir,
        token: 'relayed-permission-token',
        forward: (envelope) => {
          pair.forwarded.push(envelope)
          const delivered = filter(envelope)
          if (pair.connected && delivered) {
            desktop.ingestRemote(delivered, 'conn-1')
          }
        }
      })
      running.push(pair.relay)
      await pair.relay.start({ publishEndpoint: false })
    }
  }
  await pair.restart()
  return pair
}

describe('a relayed request bound to its single in-flight call (recorded decline)', () => {
  it('clears live at the batch that settles it; batches that settle nothing shown change neither side’s row', async () => {
    const pair = await startDeclinePair()
    for (const raw of decline.slice(0, declineBatch)) {
      await pair.post(raw)
    }
    expect(row(pair.desktop)).toMatchObject({ state: 'waiting', toolName: 'Read' })
    expect(await pair.post(decline[declineBatch])).toBe('working')
    await pair.post(decline[declineBatch + 1])
    await pair.post(decline[declineBatch + 2])
    const cached = relayRow(pair.relay)
    const shown = row(pair.desktop)
    // The next recorded batch settles a call no one is waiting on.
    await pair.post(decline[declineBatch + 3])
    expect(row(pair.desktop)).toEqual(shown)
    expect(relayRow(pair.relay)).toBe(cached)
    expect(
      pair.forwarded
        .filter((envelope) => envelope.hookEventName === 'PostToolBatch')
        .map((envelope) => envelope.claudeBatchSettledRequests)
    ).toEqual([[{ toolUseId: 'tool_use_id-1' }], [{ toolUseId: 'tool_use_id-2' }]])
  })

  it('clears on reconnect when the batch settled it while the desktop was away', async () => {
    const pair = await startDeclinePair()
    for (const raw of decline.slice(0, declineBatch)) {
      await pair.post(raw)
    }
    pair.connected = false
    for (const raw of decline.slice(declineBatch, declineBatch + 3)) {
      await pair.post(raw)
    }
    pair.connected = true
    pair.relay.replayCachedPayloadsForPanes()
    expect(row(pair.desktop).state).toBe('working')
  })

  it('clears on reconnect right after the batch, with no later tool activity', async () => {
    const pair = await startDeclinePair()
    for (const raw of decline.slice(0, declineBatch)) {
      await pair.post(raw)
    }
    pair.connected = false
    await pair.post(decline[declineBatch])
    pair.connected = true
    pair.relay.replayCachedPayloadsForPanes()
    expect(row(pair.desktop).state).toBe('working')
    expect(pair.forwarded.at(-1)).toMatchObject({
      isReplay: true,
      hookEventName: 'PostToolBatch',
      claudeBatchSettledRequests: [{ toolUseId: 'tool_use_id-1' }]
    })
  })

  it('replays a cached question unchanged when a batch settles something else', async () => {
    const pair = await startDeclinePair()
    const [start, submit] = decline
    const root = { session_id: start.session_id, prompt_id: submit.prompt_id }
    const question = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which?' }] }
    }
    await pair.post(start)
    await pair.post(submit)
    await pair.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'Q', ...question })
    expect(await pair.post({ ...root, hook_event_name: 'PermissionRequest', ...question })).toBe(
      'waiting'
    )
    pair.connected = false
    await pair.post({
      ...root,
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_use_id: 'other' }]
    })
    pair.connected = true
    pair.relay.replayCachedPayloadsForPanes()
    expect(row(pair.desktop)).toMatchObject({ state: 'waiting', toolName: 'AskUserQuestion' })
  })

  it('replays a child’s settled request as the lead it displaced, not as working forever or waiting', async () => {
    const pair = await startDeclinePair()
    const [start, submit] = decline
    const root = { session_id: start.session_id, prompt_id: submit.prompt_id }
    const owner = { agent_id: 'child-a', agent_type: 'general-purpose' }
    const tool = { tool_name: 'Read', tool_input: { file_path: '/child' } }
    await pair.post(start)
    await pair.post(submit)
    await pair.post({ ...root, hook_event_name: 'SubagentStart', ...owner })
    await pair.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'C', ...tool, ...owner })
    expect(
      await pair.post({ ...root, hook_event_name: 'PermissionRequest', ...tool, ...owner })
    ).toBe('waiting')
    pair.connected = false
    await pair.post({
      ...root,
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_use_id: 'C' }],
      ...owner
    })
    pair.connected = true
    pair.relay.replayCachedPayloadsForPanes()
    expect(row(pair.desktop)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
  })

  it('lets a restarted relay settle the held wait after the recorded Notification arrives first', async () => {
    const pair = await startDeclinePair()
    for (const raw of decline.slice(0, declineBatch - 1)) {
      await pair.post(raw)
    }
    await pair.restart()
    expect(await pair.post(decline[declineBatch - 1])).toBe('waiting')
    expect(await pair.post(decline[declineBatch])).toBe('working')
  })

  it('settles a held call listed at position 257 of a live batch', async () => {
    const pair = await startDeclinePair()
    const [start, submit] = decline
    const root = { session_id: start.session_id, prompt_id: submit.prompt_id }
    await pair.post(start)
    await pair.post(submit)
    const ids = Array.from({ length: 300 }, (_, i) => `call-${i}`)
    await pair.post({
      ...root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_use_id: 'call-256',
      tool_input: { file_path: '/f256' }
    })
    expect(
      await pair.post({
        ...root,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Read',
        tool_input: { file_path: '/f256' }
      })
    ).toBe('waiting')
    // Another owner's batch naming the same id is not this request's settlement.
    expect(
      await pair.post({
        ...root,
        hook_event_name: 'PostToolBatch',
        agent_id: 'child-a',
        tool_calls: [{ tool_use_id: 'call-256' }]
      })
    ).toBe('waiting')
    expect(
      await pair.post({
        ...root,
        hook_event_name: 'PostToolBatch',
        tool_calls: ids.map((tool_use_id) => ({ tool_use_id }))
      })
    ).toBe('working')
  })

  it('never lets replayed batch evidence clear a request it could not name, as on main', async () => {
    const pair = await startDeclinePair()
    const [start, submit] = decline
    const root = { session_id: start.session_id, prompt_id: submit.prompt_id }
    const tool = { tool_name: 'Read', tool_input: { file_path: '/same' } }
    for (const raw of [start, submit]) {
      await pair.post(raw)
    }
    await pair.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'T', ...tool })
    await pair.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'U', ...tool })
    // Two identical calls in flight: the request cannot be named and takes main's path.
    expect(await pair.post({ ...root, hook_event_name: 'PermissionRequest', ...tool })).toBe(
      'waiting'
    )
    pair.connected = false
    await pair.post({
      ...root,
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_use_id: 'T' }, { tool_use_id: 'U' }]
    })
    // Its cached request was never named, so the relay keeps it and replays it unchanged.
    pair.connected = true
    pair.relay.replayCachedPayloadsForPanes()
    expect(row(pair.desktop).state).toBe('waiting')
    pair.connected = false
    await pair.post({
      ...root,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'W',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    pair.connected = true
    pair.relay.replayCachedPayloadsForPanes()
    expect(pair.forwarded.at(-1)).toMatchObject({
      isReplay: true,
      claudeBatchSettledRequests: [{ toolUseId: 'T' }, { toolUseId: 'U' }]
    })
    expect(row(pair.desktop).state).toBe('waiting')
  })

  it('keeps main’s behavior for a desktop paired with a relay that predates bound requests', async () => {
    // An older relay sends no producer-supplied request id and drops batch hooks.
    const pair = await startDeclinePair((envelope) =>
      envelope.hookEventName === 'PermissionRequest'
        ? { ...envelope, toolUseId: undefined }
        : envelope.hookEventName === 'PostToolBatch'
          ? undefined
          : envelope
    )
    for (const [index, raw] of decline.slice(0, -3).entries()) {
      const state = await pair.post(raw)
      if (raw.hook_event_name === 'Stop') {
        expect(state).toBe('done')
      } else if (index >= 3) {
        expect({ index, state }).toEqual({ index, state: 'waiting' })
      }
    }
  })
})
