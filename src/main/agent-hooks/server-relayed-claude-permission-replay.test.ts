// Replay captured SSH permission hooks; single-row relay caching can hide the resolving event during disconnect.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import { RelayDispatcher } from '../../wsl-guest/dispatcher'
import { publishAgentHookEnvelope } from '../../wsl-guest/agent-hook-envelope-publication'
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
const declineBatch = decline.findIndex((raw) => raw.hook_event_name === 'PostToolBatch')
const [start, submit] = decline
const root = { session_id: start.session_id, prompt_id: submit.prompt_id }
const question = {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which?' }] }
}

/** A relay and desktop pair whose delivery can be cut, filtered, or moved to a fresh relay process. */
async function startPair(
  filter: (envelope: AgentHookRelayEnvelope) => AgentHookRelayEnvelope | undefined = (e) => e
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
    /** A fresh relay process: no represented request while the CLI keeps running. */
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

/** A desktop built before projections: it reads only the fields older receivers know. */
const olderDesktop = (envelope: AgentHookRelayEnvelope): AgentHookRelayEnvelope => {
  const { claudePermission: _projection, ...legacy } = envelope
  return legacy
}

describe('a relayed request decided by its execution host', () => {
  it('clears recorded B live at its batch on a current desktop, and keeps main’s wait on an older one', async () => {
    for (const older of [false, true]) {
      const pair = await startPair(older ? olderDesktop : undefined)
      for (const raw of decline.slice(0, declineBatch)) {
        await pair.post(raw)
      }
      expect(row(pair.desktop)).toMatchObject({ state: 'waiting', toolName: 'Read' })
      expect({ older, state: await pair.post(decline[declineBatch]) }).toEqual({
        older,
        state: older ? 'waiting' : 'working'
      })
    }
  })

  it.each(['question', 'elicitation'] as const)(
    'catches a desktop that missed a newer %s up to it at the older request’s batch, under its own identity',
    async (kind) => {
      let dropNewer = true
      const pair = await startPair((envelope) =>
        dropNewer &&
        (envelope.payload?.toolName === 'AskUserQuestion' ||
          envelope.hookEventName === 'Elicitation')
          ? undefined
          : envelope
      )
      const tool = { tool_name: 'Read', tool_input: { file_path: '/a' } }
      await pair.post(start)
      await pair.post(submit)
      await pair.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'A', ...tool })
      expect(await pair.post({ ...root, hook_event_name: 'PermissionRequest', ...tool })).toBe(
        'waiting'
      )
      if (kind === 'question') {
        await pair.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'Q', ...question })
        await pair.post({ ...root, hook_event_name: 'PermissionRequest', ...question })
      } else {
        await pair.post({
          ...root,
          hook_event_name: 'Elicitation',
          mcp_server_name: 'server',
          message: 'Allow?',
          mode: 'form'
        })
      }
      expect(row(pair.desktop)).toMatchObject({ state: 'waiting', toolName: 'Read' })
      dropNewer = false
      await pair.post({
        ...root,
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ ...tool, tool_use_id: 'A', tool_response: 'denied' }]
      })
      expect(row(pair.desktop).state).toBe('waiting')
      const state: unknown = Reflect.get(pair.desktop, 'state')
      const rows =
        typeof state === 'object' && state !== null
          ? Reflect.get(state, 'lastStatusByPaneKey')
          : undefined
      const stored: unknown =
        rows instanceof Map || (typeof rows === 'object' && rows !== null && 'get' in rows)
          ? Reflect.apply(Reflect.get(rows, 'get'), rows, [PANE])
          : undefined
      expect(stored).toMatchObject(
        kind === 'question'
          ? { hookEventName: 'PermissionRequest', payload: { toolName: 'AskUserQuestion' } }
          : { hookEventName: 'Elicitation' }
      )
      expect(pair.forwarded.at(-1)).toMatchObject(
        kind === 'question'
          ? { hookEventName: 'PermissionRequest', payload: { toolName: 'AskUserQuestion' } }
          : { hookEventName: 'Elicitation' }
      )
    }
  )

  it('never lets a restarted relay clear a wait the desktop still holds, and discloses NC3', async () => {
    const pair = await startPair()
    for (const raw of decline.slice(0, declineBatch)) {
      await pair.post(raw)
    }
    await pair.restart()
    // The new relay has not seen this pane's dialog, so the desktop keeps deciding for itself.
    expect(
      await pair.post({
        ...root,
        hook_event_name: 'PreToolUse',
        tool_use_id: 'later',
        tool_name: 'Bash',
        tool_input: { command: 'ls' }
      })
    ).toBe('waiting')

    // NC3, accepted Brennan 2026-11-03: a restart between a tool's start and its prompt loses the
    // predecessor main's desktop would inherit, so the approved prompt waits for its batch.
    const nc3 = await startPair()
    const tool = { tool_name: 'Read', tool_input: { file_path: '/t' } }
    await nc3.post(start)
    await nc3.post(submit)
    await nc3.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'T', ...tool })
    await nc3.restart()
    expect(await nc3.post({ ...root, hook_event_name: 'PermissionRequest', ...tool })).toBe(
      'waiting'
    )
    expect(
      await nc3.post({
        ...root,
        hook_event_name: 'PostToolUse',
        tool_use_id: 'T',
        tool_response: 'ok',
        ...tool
      })
    ).toBe('waiting')
    expect(
      await nc3.post({
        ...root,
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ ...tool, tool_use_id: 'T' }]
      })
    ).toBe('working')
  })

  it('replays a held request a desktop never saw, with that request’s own card', async () => {
    const pair = await startPair()
    await pair.post(start)
    await pair.post(submit)
    pair.connected = false
    for (const raw of decline.slice(2, declineBatch)) {
      await pair.post(raw)
    }
    pair.connected = true
    pair.relay.replayCachedPayloadsForPanes()
    expect(row(pair.desktop)).toMatchObject({ state: 'waiting', toolName: 'Read' })
  })

  it('still recovers an older desktop through the shipped per-tool replay after it missed the approval', async () => {
    const pair = await startPair(olderDesktop)
    const tool = { tool_name: 'Read', tool_input: { file_path: '/t' } }
    await pair.post(start)
    await pair.post(submit)
    await pair.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'T', ...tool })
    expect(await pair.post({ ...root, hook_event_name: 'PermissionRequest', ...tool })).toBe(
      'waiting'
    )
    pair.connected = false
    await pair.post({
      ...root,
      hook_event_name: 'PostToolUse',
      tool_use_id: 'T',
      tool_response: 'ok',
      ...tool
    })
    await pair.post({
      ...root,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'Z',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    pair.connected = true
    pair.relay.replayCachedPayloadsForPanes()
    expect(row(pair.desktop).state).toBe('working')
  })
})

/** The WSL relay's real publication path into a 64 KiB stdout sink that can stall, feeding current and older desktops. */
async function startSinkPair() {
  const frames: Buffer[] = []
  const drainListeners = new Set<() => void>()
  let blocked = false
  const dispatcher = new RelayDispatcher(
    (data) => {
      frames.push(Buffer.from(data))
      return !blocked
    },
    {
      writableHighWaterMark: () => 65536,
      writableLength: () => 0,
      waitWriteDrain: (callback) => {
        drainListeners.add(callback)
        return () => drainListeners.delete(callback)
      }
    }
  )
  running.push({ stop: () => dispatcher.dispose() })
  const current = new AgentHookServer()
  const older = new AgentHookServer()
  running.push(current, older)
  const endpointDir = mkdtempSync(join(tmpdir(), 'orca-relayed-permission-'))
  temporaryPaths.push(endpointDir)
  const relay = new RelayAgentHookServer({
    endpointDir,
    token: 'relayed-permission-token',
    forward: (envelope) => publishAgentHookEnvelope(dispatcher, envelope)
  })
  running.push(relay)
  await relay.start({ publishEndpoint: false })
  let read = 0
  /** Decoded envelopes written since the last call, to the given desktops (all by default). */
  const deliver = (to: AgentHookServer[] = [current, older]) => {
    const envelopes: AgentHookRelayEnvelope[] = []
    for (const frame of frames.slice(read)) {
      const length = frame.readUInt32BE(9)
      const message =
        length > 0 ? JSON.parse(frame.subarray(13, 13 + length).toString('utf-8')) : null
      if (message?.method === 'agent.hook') {
        envelopes.push(message.params)
        for (const desktop of to) {
          desktop.ingestRemote(
            desktop === older ? olderDesktop(message.params) : message.params,
            'conn-1'
          )
        }
      }
    }
    read = frames.length
    return envelopes
  }
  return {
    current,
    older,
    relay,
    post: async (raw: Record<string, unknown>) => {
      const { port, token } = relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(raw))
      })
      expect(response.status).toBe(204)
    },
    /** Writes are accepted but never settle until drained, as a full pipe. */
    block: () => {
      blocked = true
      for (const size of [8_000, 512, 16]) {
        for (let attempt = 0; attempt < 5_000; attempt++) {
          if (!dispatcher.tryNotifyPtyData({ id: 'pty-1', data: 'x'.repeat(size) })) {
            break
          }
        }
      }
    },
    drain: async () => {
      blocked = false
      for (const listener of Array.from(drainListeners)) {
        drainListeners.delete(listener)
        listener()
      }
      // One redelivery interval carries any snapshot still owed.
      await new Promise((resolve) => setTimeout(resolve, 400))
    },
    deliver
  }
}

describe('current-state delivery through the relay’s real sink', () => {
  const tool = { tool_name: 'Read', tool_input: { file_path: '/a' } }
  const waitingOnA = async () => {
    const sink = await startSinkPair()
    await sink.post(start)
    await sink.post(submit)
    await sink.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'A', ...tool })
    await sink.post({ ...root, hook_event_name: 'PermissionRequest', ...tool })
    sink.deliver()
    expect(row(sink.current).state).toBe('waiting')
    return sink
  }

  it('reaches the latest state after 257 batches pile up behind a stalled sink, with nothing older owed', async () => {
    const sink = await waitingOnA()
    sink.block()
    await sink.post({
      ...root,
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ ...tool, tool_use_id: 'A' }]
    })
    for (let i = 0; i < 256; i++) {
      await sink.post({
        ...root,
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_use_id: `later-${i}` }]
      })
    }
    // Nothing got through while stalled.
    sink.deliver()
    expect(row(sink.current).state).toBe('waiting')
    await sink.drain()
    sink.deliver()
    expect(row(sink.current).state).toBe('working')
    // The older desktop keeps its own hold, as on main: the batch improvement waits for its update.
    expect(row(sink.older).state).toBe('waiting')
  })

  it('fits a release among short and 256-character ids with a large assistant message and roster', async () => {
    const sink = await startSinkPair()
    await sink.post(start)
    await sink.post(submit)
    for (let i = 0; i < 600; i++) {
      await sink.post({
        ...root,
        hook_event_name: 'SubagentStart',
        agent_id: `child-${i}`,
        agent_type: 'general-purpose'
      })
    }
    await sink.post({
      ...root,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'big',
      tool_name: 'Bash',
      tool_input: { command: 'cat big' }
    })
    await sink.post({
      ...root,
      hook_event_name: 'PostToolUse',
      tool_use_id: 'big',
      tool_name: 'Bash',
      tool_input: { command: 'cat big' },
      tool_response: 'r'.repeat(60_000)
    })
    await sink.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'A', ...tool })
    await sink.post({ ...root, hook_event_name: 'PermissionRequest', ...tool })
    sink.deliver()
    expect(row(sink.current).state).toBe('waiting')
    const ids = [
      's',
      'l'.repeat(256),
      'A',
      ...Array.from({ length: 300 }, (_, i) => `${i}`.padStart(256, 'v'))
    ]
    await sink.post({
      ...root,
      hook_event_name: 'PostToolBatch',
      tool_calls: ids.map((tool_use_id) =>
        tool_use_id === 'A' ? { ...tool, tool_use_id } : { tool_use_id }
      )
    })
    sink.deliver()
    expect(row(sink.current).state).toBe('working')
  })

  it('shows an older desktop the newer question, not the older request’s working outcome, after a stall', async () => {
    const sink = await waitingOnA()
    sink.block()
    await sink.post({
      ...root,
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ ...tool, tool_use_id: 'A' }]
    })
    await sink.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'Q', ...question })
    await sink.post({ ...root, hook_event_name: 'PermissionRequest', ...question })
    sink.deliver()
    expect(row(sink.older)).toMatchObject({ state: 'waiting', toolName: 'Read' })
    await sink.drain()
    sink.deliver()
    for (const desktop of [sink.current, sink.older]) {
      expect(row(desktop)).toMatchObject({ state: 'waiting', toolName: 'AskUserQuestion' })
    }
  })
})

describe('the represented request across lifecycle refreshes, new conversations and large replays', () => {
  const tool = { tool_name: 'Read', tool_input: { file_path: '/a' } }

  it('keeps the request through a child start on the relay, replays it as itself, and clears at its batch', async () => {
    const pair = await startPair()
    await pair.post(start)
    await pair.post({ ...root, hook_event_name: 'UserPromptSubmit', prompt: 'Read /a' })
    await pair.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'A', ...tool })
    await pair.post({ ...root, hook_event_name: 'PermissionRequest', ...tool })
    expect(
      await pair.post({
        ...root,
        hook_event_name: 'SubagentStart',
        agent_id: 'child-c',
        agent_type: 'general-purpose'
      })
    ).toBe('waiting')
    pair.relay.replayCachedPayloadsForPanes()
    expect(pair.forwarded.at(-1)?.claudePermission).toMatchObject({
      held: true,
      row: { hookEventName: 'PermissionRequest', payload: { toolName: 'Read' } }
    })
    expect(
      await pair.post({
        ...root,
        hook_event_name: 'PostToolBatch',
        tool_calls: [{ ...tool, tool_use_id: 'A' }]
      })
    ).toBe('working')
  })

  it('ends a helper’s request when a new conversation starts, with nothing of the old one left to replay', async () => {
    const pair = await startPair()
    const helper = { agent_id: 'hook-agent-1' }
    await pair.post(start)
    await pair.post(submit)
    await pair.post({
      ...root,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'H',
      ...tool,
      ...helper
    })
    expect(
      await pair.post({ ...root, hook_event_name: 'PermissionRequest', ...tool, ...helper })
    ).toBe('waiting')
    expect(
      await pair.post({
        ...start,
        session_id: '22222222-2222-4222-8222-222222222222',
        source: 'clear'
      })
    ).toBe('done')
    pair.relay.replayCachedPayloadsForPanes()
    expect(pair.forwarded.at(-1)?.claudePermission).toEqual({ version: 1 })
    expect(row(pair.desktop).state).toBe('done')
  })

  it('replays a held request to a desktop that missed it after 600 children came and went, through the real sink', async () => {
    const sink = await startSinkPair()
    await sink.post(start)
    await sink.post(submit)
    for (let i = 0; i < 600; i++) {
      await sink.post({
        ...root,
        hook_event_name: 'SubagentStart',
        agent_id: `child-${i}`,
        agent_type: 'general-purpose'
      })
    }
    await sink.post({ ...root, hook_event_name: 'PreToolUse', tool_use_id: 'A', ...tool })
    await sink.post({ ...root, hook_event_name: 'PermissionRequest', ...tool })
    await sink.post({
      ...root,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'U',
      tool_name: 'Bash',
      tool_input: { command: 'true' }
    })
    for (let i = 0; i < 600; i++) {
      await sink.post({ ...root, hook_event_name: 'SubagentStop', agent_id: `child-${i}` })
    }
    sink.deliver()
    const late = new AgentHookServer()
    running.push(late)
    sink.relay.replayCachedPayloadsForPanes()
    const [replay] = sink.deliver([late])
    // The held request carries the pane's current roster, not the 600 children that have since ended.
    expect(replay?.claudePermission?.row?.payload.subagents ?? []).toEqual([])
    expect(row(late)).toMatchObject({ state: 'waiting', toolName: 'Read' })
  })
})
