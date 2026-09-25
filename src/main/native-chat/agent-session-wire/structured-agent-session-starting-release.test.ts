// A Claude chat is published before its CLI answers initialize, and a message sent in that window
// is accepted and stays queued until it does; the delivery loop hands it over once startup lands.
// The idle sweep ticks meanwhile. Inside the idle window it must leave that queued message and the
// starting child alone, and every journal publish — the handover included — starts the window
// again; only a chat quiet for the whole window loses its agent.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
const SWEEP_MS = 5
const IDLE_MS = 1_000

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let claude: ReturnType<typeof fakeClaude>
let landInit: () => void
let lifecycle: Promise<void>[]
let clock: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-starting-release-'))
  resetHostTestOperationIds()
  claude = fakeClaude()
  lifecycle = []
  clock = NOW
  const initLanded = new Promise<void>((resolve) => {
    landInit = resolve
  })
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    // As the runtime wires it: an admitted prompt's outcome reaches the journal out of band.
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    // Initialize answers only when the test says so.
    openConnection: async (launch, handlers) => {
      const connection = await claude.openConnection(launch, handlers)
      const answer = connection.initializationResult
      connection.initializationResult = async () => {
        await initLanded
        return answer()
      }
      return connection
    },
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    idleSweep: { intervalMs: SWEEP_MS, idleMs: IDLE_MS },
    now: () => clock
  })
})

afterEach(async () => {
  vi.useRealTimers()
  landInit()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

async function attachStarting(): Promise<void> {
  const created = await host.attach(
    CALLER,
    hostTestAttachParams(null, {
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
    })
  )
  expect(created).toMatchObject({ ok: true })
}

async function send(text: string, dispatchState = 'pending'): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState } } })
  return sent.ok ? sent.value.clientMessageId : ''
}

async function dispatchState(clientMessageId: string): Promise<string | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )?.dispatchState
}

/** The delivery loop hands a message over on its own serialized steps after startup lands; this
 *  yields to them without moving the host clock. */
async function untilSent(connection: { sent: unknown[] }): Promise<void> {
  for (let turn = 0; turn < 2000 && connection.sent.length === 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Long enough for many sweep ticks, so "not stopped" means the sweep declined. */
function waitOutSeveralSweeps(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 20))
}

describe('a Claude chat whose CLI is still starting', () => {
  it('keeps a message queued inside the idle window, and delivers it once startup lands', async () => {
    await attachStarting()
    const held = await send('sent while starting')

    clock += IDLE_MS - 1
    await waitOutSeveralSweeps()

    expect(host.hasSession(SESSION)).toBe(true)
    expect(claude.connections[0].closeCount).toBe(0)
    expect(await dispatchState(held)).toBe('pending')

    landInit()
    await adapter.awaitStarted(SESSION)

    await vi.waitFor(
      () => expect(claude.connections[0].sent).toEqual([expect.objectContaining({ type: 'user' })]),
      { timeout: 3000 }
    )
    await vi.waitFor(async () => expect(await dispatchState(held)).toBe('accepted'))
  })

  it('gives the message it hands over at startup a full idle window to open its turn', async () => {
    await attachStarting()
    const held = await send('sent while starting')
    const connection = claude.connections[0]
    // Claude echoes a prompt only when it starts that turn, which a loaded machine delays.
    connection.send = async (message) => {
      connection.sent.push(message)
    }
    clock += IDLE_MS - 1
    await waitOutSeveralSweeps()
    expect(host.hasSession(SESSION)).toBe(true)

    // Startup lands just before the window closes; the handover's publish starts it again.
    landInit()
    await adapter.awaitStarted(SESSION)
    await Promise.all(lifecycle)
    await untilSent(connection)
    expect(connection.sent).toEqual([expect.objectContaining({ type: 'user' })])
    clock += IDLE_MS - 1
    await waitOutSeveralSweeps()

    expect(host.hasSession(SESSION)).toBe(true)
    expect(connection.closeCount).toBe(0)
    connection.handlers.onMessage?.(connection.sent[0])
    await host.flushStreamedEvents(SESSION)
    await waitOutSeveralSweeps()
    expect(host.hasSession(SESSION)).toBe(true)
    expect(await dispatchState(held)).toBe('accepted')
  })

  it('stops the agent and closes the conversation once its turn has finished and it idled', async () => {
    await attachStarting()
    landInit()
    await adapter.awaitStarted(SESSION)
    const answered = await send('answered')
    await vi.waitFor(async () => expect(await dispatchState(answered)).toBe('accepted'))
    claude.connections[0].handlers.onMessage?.({
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: PROVIDER_SESSION_ID,
      is_error: false,
      result: 'done'
    })
    await host.flushStreamedEvents(SESSION)
    expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(1)

    clock += IDLE_MS

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('stops a start that stayed quiet for the whole window when it owes nothing', async () => {
    await attachStarting()

    clock += IDLE_MS

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(claude.connections[0].closeCount).toBe(1)
  })
})
