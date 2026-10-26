import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { acpChildWorkStatusSink } from '../../acp/acp-structured-child-work.test-support'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  claudeStartupSettled,
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import { claudeStructuredPermissionOptions } from '../../claude/claude-structured-launch-resolution'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { structuredWorkerOwesWork } from '../../runtime/structured-worker-custody'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import type * as EventSink from './structured-agent-session-event-sink'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

let revision: MockInstance<
  NonNullable<EventSink.StructuredAgentSessionEventSink['tryReviseResolvedItem']>
>

const CALLER = { callerKey: 'client-1' }
vi.mock('./structured-agent-session-event-sink', async (importOriginal) => {
  const actual = await importOriginal<typeof EventSink>()
  return {
    ...actual,
    createDeferredStructuredAgentSessionEventSink: (
      deps: Parameters<typeof actual.createDeferredStructuredAgentSessionEventSink>[0]
    ) => {
      const sink = actual.createDeferredStructuredAgentSessionEventSink({
        ...deps,
        watermarks: {
          maxQueuedOperations: 4,
          maxLifecycleQueuedOperations: 4,
          pauseQueuedOperations: 2,
          lowQueuedOperations: 1
        }
      })
      revision = vi.spyOn(sink.sink, 'tryReviseResolvedItem')
      return sink
    }
  }
})

let releaseBarriers: (() => void)[] = []
let claudeFrames: { replayUuid: null; initProof?: 'none' }
let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let records: ReturnType<typeof acpChildWorkStatusSink>
let orchestration: OrchestrationDb
/** The host's clock, which stamps every child's start and end. */
let clock = NOW

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-subagent-row-'))
  clock = NOW
  releaseBarriers = []
  resetHostTestOperationIds()
  const log = recordingStructuredAgentSessionLogger()
  claudeFrames = { replayUuid: null }
  claude = fakeClaude(claudeFrames)
  orchestration = new OrchestrationDb(':memory:')
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async ({ permissionMode }) => ({
      pathToClaudeCodeExecutable: 'claude',
      options: claudeStructuredPermissionOptions(permissionMode ?? 'ask'),
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      // A later child resumes the transcript the first one started.
      resumesTranscript: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0,
      continuesChain: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
    }),
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        void host.handleAdapterEvent(mapped)
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    persistHandle: async () => undefined,
    logger: log.logger,
    onChildWorkEvidence: (sessionId, evidence, producer) =>
      host.publishChildWorkEvidence(sessionId, evidence, producer),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => clock
  })
  store = await openTestAgentSessionRecordStore(root)
  records = acpChildWorkStatusSink()
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexAgents(adapter),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: log.logger,
    // The host's child records live in a real hook server's store, as in production.
    statusSink: records.sink,
    hasOpenDispatch: (record) => structuredWorkerOwesWork(orchestration, record),
    now: () => clock
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    options: { model: 'haiku', permissionMode: 'auto' },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await claudeStartupSettled(adapter, SESSION)
})

afterEach(async () => {
  releaseBarriers.forEach((release) => release())
  setStructuredAgentSessionHost(null)
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  orchestration.close()
  await rm(root, { recursive: true, force: true })
})

function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

function envelope(method: 'agentSession.send' | 'agentSession.cancel', fields: Fields) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

type Fields = Parameters<typeof computeAgentSessionPayloadFingerprint>[0]['fields']

async function sendAndEcho(connection: FakeConnection, text: string): Promise<void> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  expect(sent.ok).toBe(true)
  await eventually(() =>
    expect(connection.sent.some((message) => JSON.stringify(message).includes(text))).toBe(true)
  )
  frame(connection, { type: 'system', subtype: 'init', uuid: 'init-1', model: 'claude-sonnet-5' })
  frame(connection, { ...connection.sent.at(-1)! })
}

it('retains the root end under pressure so the same input progresses once without closing', async () => {
  const written = (on: FakeConnection, text: string) =>
    on.sent.find((message) => JSON.stringify(message).includes(text))
  const snapshot = () => host.journalSnapshot(SESSION)
  const connection = claude.connections[0]!
  await sendAndEcho(connection, 'A before pressure')
  await host.flushStreamedEvents(SESSION)
  const collaborators = host.collaboratorsForTests()
  const journal = collaborators.sessions.get(SESSION)!.journal
  const sink = collaborators.runtimeState.currentEventSink(SESSION)!
  const target = host.currentWork(SESSION)!.activeTurnId()
  expect(target).not.toBeNull()
  for (let index = 0; index < 4; index += 1) {
    frame(connection, {
      type: 'stream_event',
      uuid: `unfinished-thinking-${index}`,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: 'x' }
      }
    })
    await host.flushStreamedEvents(SESSION)
  }
  revision.mockClear()
  frame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
  expect(sink.state()).toMatchObject({ backpressured: true, failed: false })
  expect(sink.state().queuedOperations).toBeGreaterThan(4)
  expect(revision.mock.results.map(({ value }) => value)).toContainEqual({ accepted: true })
  await host.flushStreamedEvents(SESSION)
  expect(host.currentWork(SESSION)?.activeTurnId()).toBeNull()
  expect(
    (await snapshot()).items
      .map(({ body }) => readAgentJournalTurn(body))
      .find((turn) => turn?.turnId === target)
  ).toMatchObject({ state: 'completed' })

  // A mistakenly requested close cannot unblock the input in this fixture.
  const releaseClose = Promise.withResolvers<void>()
  releaseBarriers.push(() => releaseClose.resolve())
  const close = connection.close.bind(connection)
  const closing = vi.spyOn(connection, 'close').mockImplementation(async () => {
    await releaseClose.promise
    return close()
  })
  const body = hostTestMessage('B after pressured end')
  const capture = { model: 'haiku', effort: 'high' }
  const sendEnvelope = envelope('agentSession.send', { body, options: capture })
  const bId = sendEnvelope.clientOperationId
  const pending = vi.spyOn(journal, 'resolveDispatch')
  const dispatch = vi.spyOn(adapter, 'dispatch')
  expect(await host.send(CALLER, { envelope: sendEnvelope, body, options: capture })).toMatchObject(
    { ok: true }
  )
  await eventually(() => expect(written(connection, 'B after pressured end')).toBeDefined())
  const bInput = dispatch.mock.calls.filter(([input]) => input.clientMessageId === bId)
  expect(bInput).toHaveLength(1)
  expect(bInput[0]![0]).toMatchObject({ body, executionOptions: capture })
  expect(
    pending.mock.calls.filter(
      ([input]) => input.clientMessageId === bId && input.state === 'pending'
    )
  ).toHaveLength(1)
  expect(closing).not.toHaveBeenCalled()
  expect(claude.connections).toHaveLength(1)
  frame(connection, {
    ...written(connection, 'B after pressured end')!,
    isReplay: true,
    parent_tool_use_id: null
  })
  frame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
  await host.flushStreamedEvents(SESSION)
  await eventually(() =>
    expect(collaborators.conversationDelivery.loop.isRunning(SESSION)).toBe(false)
  )
  expect(dispatch.mock.calls.filter(([input]) => input.clientMessageId === bId)).toHaveLength(1)
  expect(
    connection.sent.filter((message) => JSON.stringify(message).includes('B after pressured end'))
  ).toHaveLength(1)
  expect(
    (await snapshot()).submissions.find(({ clientMessageId }) => clientMessageId === bId)
  ).toMatchObject({
    clientMessageId: bId,
    options: capture,
    dispatchState: 'accepted'
  })
  expect(closing).not.toHaveBeenCalled()
})
