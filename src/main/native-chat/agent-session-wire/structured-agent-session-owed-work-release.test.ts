import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentHookServer, _internals } from '../../agent-hooks/server'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
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
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

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
const server = new AgentHookServer()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-owed-work-release-'))
  _internals.resetCachesForTests()
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
      cliFlag: async () => 'supported' as const,
      continuesChain: false
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    onChildWorkEvidence: (sessionId, evidence) =>
      host.publishChildWorkEvidence(sessionId, evidence),
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
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    idleSweep: { intervalMs: SWEEP_MS, idleMs: IDLE_MS },
    now: () => clock,
    statusSink: {
      publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
      forget: (subject) => server.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        server.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
    }
  })
})

afterEach(async () => {
  vi.useRealTimers()
  landInit()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
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

/** Yield to delivery without advancing host time. */
async function untilSent(connection: { sent: unknown[] }): Promise<void> {
  for (let turn = 0; turn < 2000 && connection.sent.length === 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Observe enough ticks to distinguish a declined sweep from one that never ran. */
function waitOutSeveralSweeps(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 20))
}

describe('a Claude chat whose CLI is still starting', () => {
  it('holds a message until startup lands, and keeps the agent inside the idle window meanwhile', async () => {
    await attachStarting()
    const sent = await send('sent while starting')

    expect(claude.connections[0].sent).toEqual([])
    expect(await dispatchState(sent)).toBe('pending')
    clock += IDLE_MS - 1
    await waitOutSeveralSweeps()

    expect(claude.connections[0].sent).toEqual([])
    expect(await dispatchState(sent)).toBe('pending')
    expect(host.hasSession(SESSION)).toBe(true)
    expect(claude.connections[0].closeCount).toBe(0)

    landInit()
    await vi.waitFor(() =>
      expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
    )
    await untilSent(claude.connections[0])
    expect(claude.connections[0].sent).toEqual([expect.objectContaining({ type: 'user' })])
    await vi.waitFor(async () => expect(await dispatchState(sent)).toBe('accepted'))
    expect(host.hasSession(SESSION)).toBe(true)
  })

  it('gives a message held while starting a full idle window after startup lands to open its turn', async () => {
    claude = fakeClaude({ replayUuid: null })
    await attachStarting()
    const connection = claude.connections[0]
    // Loaded runners may delay Claude’s first turn echo.
    const held = await send('sent while starting')
    expect(connection.sent).toEqual([])
    expect(await dispatchState(held)).toBe('pending')
    clock += IDLE_MS - 1
    await waitOutSeveralSweeps()
    expect(connection.sent).toEqual([])
    expect(await dispatchState(held)).toBe('pending')
    expect(host.hasSession(SESSION)).toBe(true)

    // Startup just before expiry renews activity through handover.
    landInit()
    await vi.waitFor(() =>
      expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
    )
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
    await vi.waitFor(async () => expect(await dispatchState(held)).toBe('accepted'))
  })

  it('stops the agent and closes the conversation once its turn has finished and it idled', async () => {
    await attachStarting()
    landInit()
    await vi.waitFor(() =>
      expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
    )
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

describe('a chat whose settled lead still has background work running', () => {
  function frame(message: Record<string, unknown>): void {
    claude.connections[0].handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
  }

  async function settleTurnLeavingTask(taskType: string): Promise<void> {
    await attachStarting()
    landInit()
    await vi.waitFor(() =>
      expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
    )
    const fanOut = await send('fan out')
    await vi.waitFor(async () => expect(await dispatchState(fanOut)).toBe('accepted'))
    frame({
      type: 'system',
      subtype: 'task_started',
      uuid: 'task-start-1',
      task_id: 'task-1',
      task_type: taskType,
      is_backgrounded: true
    })
    frame({ type: 'result', subtype: 'success', uuid: 'result-1', is_error: false, result: 'ok' })
    await host.flushStreamedEvents(SESSION)
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok ? page.page.backgroundTasks?.children : null).toEqual([
      expect.objectContaining({ providerId: 'task-1', membership: 'live' })
    ])
  }

  it.each([
    ['a subagent', 'local_agent'],
    ['a background command', 'local_bash'],
    ['a monitor', 'monitor']
  ])('keeps the agent while %s runs, then stops it once that settles', async (_, type) => {
    await settleTurnLeavingTask(type)

    clock += IDLE_MS
    await waitOutSeveralSweeps()

    expect(host.hasSession(SESSION)).toBe(true)
    expect(claude.connections[0].closeCount).toBe(0)

    frame({
      type: 'system',
      subtype: 'task_notification',
      uuid: 'task-done-1',
      task_id: 'task-1',
      status: 'completed'
    })
    // Child completion still owes the lead’s wake-up turn.
    frame({ type: 'result', subtype: 'success', uuid: 'result-2', is_error: false, result: 'ok' })
    await host.flushStreamedEvents(SESSION)
    clock += IDLE_MS

    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
    expect(claude.connections[0].closeCount).toBe(1)
  })
})
