// Background helpers outlive spawn/turn results; unrecorded work must remain visible and resist idle eviction.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { recordAgentSessionRanOptions } from '../../runtime/agent-session-record-options'
import { isSubagentBlock } from '../../../shared/native-chat-types'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { acpChildWorkStatusSink } from '../../acp/acp-structured-child-work.test-support'
import {
  MOVED_TO_BACKGROUND,
  RESUMED_BY_MESSAGE
} from '../../claude/claude-captured-task-frames.test-fixture'
import { WAKES_AFTER_ITS_SHELL } from '../../claude/claude-captured-wake-frames.test-fixture'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  claudeStartupSettled,
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { claudeStructuredPermissionOptions } from '../../claude/claude-structured-launch-resolution'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { reconcileLifecycleMessage } from '../../runtime/orchestration/lifecycle-reconciliation'
import { OrchestrationStructuredMailboxPointerDelivery } from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { createStructuredMailboxPointerHost } from '../../runtime/orchestration/structured-mailbox-pointer-host'
import { structuredWorkerOwesWork } from '../../runtime/structured-worker-custody'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
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

async function savedRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'message' ? item.body.blocks.filter(isSubagentBlock) : []
  )
}

it('keeps worker mail and native results on the live process, then reopens for the captured user choice', async () => {
  const db = orchestration
  const runId = 'run_legacy_local'
  const handle = 'structworker_transition'
  const task = db.createTask({ runId, spec: 'Read the result and report completion.' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle,
    paneKey: null,
    processIncarnation: `structured:${SESSION}`,
    worktreeId: 'workspace-1',
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: 'created',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
  })
  db.markWorkerDispatchReady(dispatch.id)
  expect(structuredWorkerOwesWork(db, store.getRecord(SESSION)!)).toBe(true)
  const first = claude.connections[0]!
  expect(first.launch.options).toMatchObject({ model: 'haiku', permissionMode: 'auto' })
  frame(first, {
    type: 'system',
    subtype: 'init',
    uuid: 'first-root',
    model: 'claude-haiku-4-5',
    permissionMode: 'default'
  })
  await sendAndEcho(first, 'Run it in the background.')
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(({ at }) => at <= 4_765).entries()) {
    frame(first, { uuid: `launch-${index}`, ...captured.frame })
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual([expect.objectContaining({ state: 'working' })])
  )
  await store.replaceSessionOptions({
    sessionId: SESSION,
    fence: store.getRecord(SESSION)!.lease.runtimeFence,
    options: { model: 'opus' },
    now: clock
  })
  const body = hostTestMessage('Use my new model now.')
  const refused = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body }),
    body
  })
  expect(refused.ok).toBe(true)
  if (!refused.ok) {
    throw new Error('send was not journaled')
  }
  await eventually(async () =>
    expect(
      (await host.journalSnapshot(SESSION)).submissions.find(
        (submission) => submission.clientMessageId === refused.value.clientMessageId
      )
    ).toMatchObject({
      dispatchState: 'rejected',
      reason: expect.stringContaining('Background tasks are still running.')
    })
  )
  expect(first.closed).toBe(false)
  expect(first.calls.some(({ subtype }) => subtype === 'set_model')).toBe(false)
  await store.replaceSessionOptions({
    sessionId: SESSION,
    fence: store.getRecord(SESSION)!.lease.runtimeFence,
    permissionMode: 'ask',
    now: clock
  })

  setStructuredAgentSessionHost(host)
  const mailboxHandle = `dispatch:${dispatch.id}`
  const mail = db.insertMessage({
    runId,
    from: 'coordinator',
    to: mailboxHandle,
    type: 'question',
    subject: 'Result ready',
    body: 'Consume this result and finish.',
    deliveryContract: 'current_delivery'
  })
  const pointers = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: SESSION, dispatchId: dispatch.id }),
    getCliCommand: () => 'orca-dev',
    senderName: () => null,
    host: createStructuredMailboxPointerHost()
  })
  expect(pointers.deliverForHandle(mailboxHandle)).toBe(true)
  await eventually(() => expect(first.sent).toHaveLength(2))
  frame(first, { ...first.sent.at(-1)!, uuid: 'mail-echo' })
  await eventually(() => expect(db.getMessageById(mail.id)?.delivered_at).not.toBeNull())
  expect(claude.connections).toHaveLength(1)
  expect(
    first.calls.some(({ subtype }) => subtype === 'set_model' || subtype === 'set_permission_mode')
  ).toBe(false)
  const pointer = (await host.journalSnapshot(SESSION)).submissions.at(-1)!
  expect(pointer.options).toBeUndefined()
  expect(store.getRecord(SESSION)?.options?.model).toBe('opus')
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(
    ({ at }) => at > 4_765 && at <= 10_960
  ).entries()) {
    frame(first, { uuid: `native-result-${index}`, ...captured.frame })
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual([
      expect.objectContaining({ state: 'completed', tokens: 15_971 })
    ])
  )
  await eventually(() => expect(host.currentWork(SESSION)?.activeTurnId()).toBeNull())
  const consumer = {
    runId,
    mailboxHandle,
    consumerGeneration: db.getDispatchContextById(dispatch.id)!.consumer_generation
  }
  const checked = db.getOrCreateMailboxDelivery(consumer)!
  expect(checked.messages.map(({ id }) => id)).toEqual([mail.id])
  expect(db.getMessageById(mail.id)?.read).toBe(0)
  db.acknowledgeMailboxDelivery({ ...consumer, deliveryId: checked.delivery.id })
  expect(db.getMessageById(mail.id)?.read).toBe(1)
  const done = db.insertMessage({
    runId,
    from: handle,
    to: 'coordinator',
    type: 'worker_done',
    subject: 'Done',
    payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
  })
  expect(reconcileLifecycleMessage(db, done).action).toBe('completed')
  expect(db.getTask(task.id)?.status).toBe('completed')
  await store.replaceSessionOptions({
    sessionId: SESSION,
    fence: store.getRecord(SESSION)!.lease.runtimeFence,
    permissionMode: 'auto',
    now: clock
  })
  const followupTask = db.createTask({ runId, spec: 'Continue on the same worker.' })
  const followup = db.createDispatchContext({
    taskId: followupTask.id,
    assigneeHandle: handle,
    processIncarnation: `structured:${SESSION}`,
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
  expect(structuredWorkerOwesWork(db, store.getRecord(SESSION)!)).toBe(true)

  const nextBody = hostTestMessage('Reply on my captured choice.')
  const options = { model: 'opus' }
  const close = first.close
  vi.spyOn(first, 'close').mockImplementationOnce(async () => {
    await store.replaceSessionOptions({
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      options: { model: 'haiku' },
      now: clock
    })
    return close()
  })
  const push = claude.connections.push.bind(claude.connections)
  vi.spyOn(claude.connections, 'push').mockImplementation((connection) => {
    const initialize = connection.initializationResult
    connection.initializationResult = async () => {
      frame(connection, {
        type: 'system',
        subtype: 'init',
        uuid: 'reopened-root',
        model: 'claude-opus-4-6',
        permissionMode: 'default'
      })
      return initialize()
    }
    return push(connection)
  })
  await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body: nextBody, options }),
    body: nextBody,
    options
  })
  await eventually(() => expect(claude.connections).toHaveLength(2))
  const second = claude.connections[1]!
  expect(first.closeCount).toBe(1)
  expect(second.launch.options).toMatchObject({ model: 'opus', permissionMode: 'auto' })
  expect(store.getRecord(SESSION)?.options?.model).toBe('haiku')
  expect(store.getRecord(SESSION)?.providerHandleChain).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        handle: expect.objectContaining({ transport: 'claude-sdk', nativeId: PROVIDER_SESSION_ID })
      })
    ])
  )
  await eventually(() => expect(second.sent).toHaveLength(1))
  frame(second, { ...second.sent[0]!, uuid: 'new-choice-echo' })
  frame(second, {
    type: 'assistant',
    uuid: 'reply-1',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'First reply.' }] }
  })
  frame(second, { type: 'result', subtype: 'success', uuid: 'result-1', result: 'First reply.' })
  await eventually(() => expect(host.currentWork(SESSION)?.activeTurnId()).toBeNull())
  const again = hostTestMessage('Reply again.')
  await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body: again, options }),
    body: again,
    options
  })
  await eventually(() => expect(second.sent).toHaveLength(2))
  frame(second, { ...second.sent[1]!, uuid: 'second-echo' })
  frame(second, {
    type: 'assistant',
    uuid: 'reply-2',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Second reply.' }] }
  })
  frame(second, { type: 'result', subtype: 'success', uuid: 'result-2', result: 'Second reply.' })
  await host.flushStreamedEvents(SESSION)
  const transcript = JSON.stringify((await host.journalSnapshot(SESSION)).items)
  expect(transcript).toContain('First reply.')
  expect(transcript).toContain('Second reply.')
  expect(claude.connections).toHaveLength(2)
  expect(db.getDispatchContextById(followup.id)?.status).toBe('dispatched')
  expect(structuredWorkerOwesWork(db, store.getRecord(SESSION)!)).toBe(true)
})

it("keeps a background helper's row working past its spawn result and its turn's end, until its own end", async () => {
  const connection = claude.connections[0]!
  await sendAndEcho(connection, 'Run it in the background.')
  // Replay through spawn and parent-turn completion, before the helper ends.
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(({ at }) => at <= 4_765).entries()) {
    frame(connection, { uuid: `launch-${index}`, ...captured.frame })
  }
  await eventually(async () => expect(await savedRows()).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(await savedRows()).toEqual([
    expect.objectContaining({ id: 'agent-1', state: 'working', background: true })
  ])
  const { items } = await host.journalSnapshot(SESSION)
  expect(activeStructuredAgentSessionTurnId(items)).toBeNull()
  expect(items.map((item) => readAgentJournalTurn(item.body)?.state)).toContain('completed')

  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(
    ({ at }) => at > 4_765 && at <= 7_427
  ).entries()) {
    frame(connection, { uuid: `run-${index}`, ...captured.frame })
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual([
      expect.objectContaining({ id: 'agent-1', state: 'completed', tokens: 15_971 })
    ])
  )
})

it("keeps an agent whose helper the store refused past idle cleanup, until the strip's Stop", async () => {
  records.sink.publishChildWork = () => undefined
  const connection = claude.connections[0]!
  await sendAndEcho(connection, 'Run it in the background.')
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(({ at }) => at <= 3_349).entries()) {
    frame(connection, { uuid: `launch-${index}`, ...captured.frame })
  }
  const strip = () => host['backgroundTasks'].read(SESSION)
  await eventually(() => expect(strip()).toMatchObject({ children: [], incomplete: true }))
  const stopStrip = () => {
    const fields = { turnId: 'background-tasks', scope: 'background-tasks' as const }
    return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
  }

  await stopStrip()
  expect(connection.closed).toBe(false)
  expect(strip()).toMatchObject({ incomplete: true })

  frame(connection, {
    uuid: 'turn-end',
    ...RESUMED_BY_MESSAGE.find(({ at }) => at === 4_765)!.frame
  })
  await host.flushStreamedEvents(SESSION)
  clock += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
  await host.collaboratorsForTests().lifetime.idleSweep.tick()
  expect(connection.closed).toBe(false)
  await expect(stopStrip()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  expect(connection.closed).toBe(true)
  await eventually(() => expect(strip()?.incomplete).toBeUndefined())
})

it('keeps a helper working while its own shell runs and through its wake-up, ending on its answer', async () => {
  const connection = claude.connections[0]!
  await sendAndEcho(connection, 'Sleep in the background.')
  const start = clock
  let next = 0
  const replay = async (until: number) => {
    for (; WAKES_AFTER_ITS_SHELL[next] && WAKES_AFTER_ITS_SHELL[next]!.at <= until; next++) {
      const captured = WAKES_AFTER_ITS_SHELL[next]!
      clock = start + captured.at
      frame(connection, { uuid: `wake-${next}`, ...captured.frame })
    }
    await host.flushStreamedEvents(SESSION)
  }
  const helper = async () => (await savedRows()).find(({ id }) => id === 'agent-1')
  const strip = () =>
    host['backgroundTasks'].read(SESSION)?.children?.map((child) => child.providerId) ?? []

  // CLI completion does not end the helper while its spawned shell still runs.
  await replay(11_913)
  await eventually(async () => expect(await helper()).toMatchObject({ state: 'working' }))
  expect(strip()).toEqual(['agent-1', 'shell-1'])

  // Restart the same helper run after its shell exits.
  await replay(44_460)
  await eventually(async () => expect(await helper()).toMatchObject({ state: 'working' }))
  expect(strip()).toEqual(['agent-1'])

  await replay(46_199)
  await eventually(async () =>
    expect(await helper()).toMatchObject({
      state: 'completed',
      tokens: 18_181,
      startedAt: start + 15,
      settledAt: start + 46_198
    })
  )
  expect(strip()).toEqual([])
  expect((await savedRows()).filter(({ id }) => id === 'agent-1')).toHaveLength(1)
})

it('settles a helper still running when its session closes as unverifiable, claiming no Stop', async () => {
  const connection = claude.connections[0]!
  await sendAndEcho(connection, 'Run it in the background.')
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(({ at }) => at <= 4_765).entries()) {
    frame(connection, { uuid: `launch-${index}`, ...captured.frame })
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual([expect.objectContaining({ state: 'working' })])
  )
  await adapter.closeSession(SESSION)
  expect(connection.closed).toBe(true)
  await eventually(async () =>
    expect(await savedRows()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
  )
  expect((await savedRows())[0]).not.toHaveProperty('outcomeBasis')
})

it('keeps a helper the next child resumes while it is still starting working, past that start’s settlement', async () => {
  const first = claude.connections[0]!
  await sendAndEcho(first, 'Run it in the background.')
  for (const [index, captured] of RESUMED_BY_MESSAGE.filter(({ at }) => at <= 4_765).entries()) {
    frame(first, { uuid: `launch-${index}`, ...captured.frame })
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual([expect.objectContaining({ state: 'working' })])
  )
  await adapter.closeSession(SESSION)
  await eventually(async () =>
    expect(await savedRows()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
  )
  // Inject helper activity before startup returns and before old-generation sweeping.
  const opened = claude.connections.push.bind(claude.connections)
  vi.spyOn(claude.connections, 'push').mockImplementation((connection) => {
    const initialize = connection.initializationResult
    connection.initializationResult = async () => {
      const initialized = await initialize()
      for (const [index, captured] of RESUMED_BY_MESSAGE.filter(
        ({ at }) => at >= 16_142 && at <= 16_143
      ).entries()) {
        frame(connection, { uuid: `resume-${index}`, ...captured.frame })
      }
      return initialized
    }
    return opened(connection)
  })
  const body = hostTestMessage('Carry on.')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(claude.connections).toHaveLength(2)
  expect(await savedRows()).toEqual([expect.objectContaining({ id: 'agent-1', state: 'working' })])
})

it('steers on current choices and returns the same unwritten input to new-turn selection at admission', async () => {
  const written = (on: FakeConnection, text: string) =>
    on.sent.find((message) => JSON.stringify(message).includes(text))
  const snapshot = async () => {
    await host.flushStreamedEvents(SESSION)
    return host.journalSnapshot(SESSION)
  }
  const send = async (text: string, options?: Record<string, string>) => {
    const body = hostTestMessage(text)
    const sent = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body, options }),
      body,
      options
    })
    if (!sent.ok) {
      throw new Error(JSON.stringify(sent.refusal))
    }
    return sent.value.clientMessageId
  }
  claudeFrames.initProof = 'none'
  const first = claude.connections[0]!
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const dispatch = vi.spyOn(adapter, 'dispatch')
  const recorded = vi.spyOn(store, 'reviseSessionOptions')
  const idle = () =>
    eventually(() =>
      expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(false)
    )
  const init = (on: FakeConnection, permissionMode = 'default') =>
    frame(on, {
      type: 'system',
      subtype: 'init',
      uuid: `init-${claude.connections.length}`,
      model: on.launch.options.model === 'opus' ? 'claude-opus-4-6' : 'claude-haiku-4-5',
      permissionMode
    })
  const echo = (on: FakeConnection, text: string) =>
    frame(on, { ...written(on, text)!, isReplay: true, parent_tool_use_id: null })
  const finish = (on: FakeConnection, text: string) => {
    const input = written(on, text)!
    frame(on, {
      type: 'assistant',
      uuid: `reply-${text}`,
      parent_tool_use_id: null,
      message: {
        id: `reply-${text}`,
        role: 'assistant',
        content: [{ type: 'text', text: `${text} result` }]
      },
      user_message_uuid: input.uuid,
      user_message_uuids: [input.uuid]
    })
    frame(on, {
      type: 'result',
      subtype: 'success',
      uuid: `result-${text}`,
      is_error: false,
      terminal_reason: 'completed',
      user_message_uuid: input.uuid,
      user_message_uuids: [input.uuid]
    })
    frame(on, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
  }
  const opened = async (text: string, options?: Record<string, string>) => {
    const id = await send(text, options)
    await eventually(() => expect(written(claude.connections.at(-1)!, text)).toBeDefined())
    const on = claude.connections.at(-1)!
    init(on)
    echo(on, text)
    await eventually(() => expect(host.currentWork(SESSION)?.activeTurnId()).not.toBeNull())
    await idle()
    return { id, on }
  }
  init(first)
  await opened('A')
  for (const captured of MOVED_TO_BACKGROUND.filter(({ at }) => at <= 11_139)) {
    frame(first, captured.frame)
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'working' })])
    )
  )
  const choices = { model: 'opus', effort: 'high', fastMode: 'true' }
  await store.replaceSessionOptions({
    sessionId: SESSION,
    fence: store.getRecord(SESSION)!.lease.runtimeFence,
    options: choices,
    now: NOW
  })
  const controls = first.calls.length
  const b = await send('B', choices)
  await eventually(() => expect(written(first, 'B')).toBeDefined())
  await idle()
  expect(first.calls.slice(controls)).toEqual([])
  expect(first.closeCount).toBe(0)
  expect(claude.connections).toHaveLength(1)
  const bIndex = dispatch.mock.calls.findIndex(([input]) => input.clientMessageId === b)
  expect(dispatch.mock.calls[bIndex]![0].executionOptions).toBeUndefined()
  expect(await dispatch.mock.results[bIndex]!.value).toMatchObject({
    state: 'admitted',
    ranOptions: { model: 'claude-haiku-4-5' }
  })
  expect(
    recorded.mock.calls.findLast(([update]) => update === recordAgentSessionRanOptions)?.[1]
  ).toMatchObject({ model: 'claude-haiku-4-5' })
  expect(
    (await snapshot()).submissions.find(({ clientMessageId }) => clientMessageId === b)?.options
  ).toEqual(choices)
  expect(await savedRows()).toEqual(
    expect.arrayContaining([expect.objectContaining({ state: 'working' })])
  )
  echo(first, 'B')
  for (const captured of MOVED_TO_BACKGROUND.filter(({ at }) => at >= 51_275 && at <= 52_441)) {
    frame(first, captured.frame)
  }
  await eventually(async () =>
    expect(await savedRows()).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'completed' })])
    )
  )
  finish(first, 'A')
  await eventually(() => expect(host.currentWork(SESSION)?.activeTurnId()).toBeNull())
  const c = await opened('C', choices)
  expect(c.on).not.toBe(first)
  expect(c.on.launch.options).toMatchObject({ model: 'opus', permissionMode: 'auto' })
  finish(c.on, 'C')
  await eventually(() => expect(host.currentWork(SESSION)?.activeTurnId()).toBeNull())
  await opened('same choice', choices)
  expect(claude.connections).toHaveLength(2)

  // Preparation is complete but pending has not entered the journal lane: still reversible.
  const release = Promise.withResolvers<void>()
  releaseBarriers.push(() => release.resolve())
  const resolve = journal.resolveDispatch.bind(journal)
  let held = false
  const pending = vi
    .spyOn(journal, 'resolveDispatch')
    .mockImplementation(async (input, cards, receipt) => {
      if (receipt && !held) {
        held = true
        await release.promise
      }
      return resolve(input, cards, receipt)
    })
  const lateCapture = { ...choices, model: 'haiku' }
  const late = await send('late preparation', lateCapture)
  await eventually(() => expect(held).toBe(true))
  const queuedLate = (await snapshot()).submissions.find(
    ({ clientMessageId }) => clientMessageId === late
  )!
  expect(queuedLate.options).toEqual(lateCapture)
  expect(queuedLate.handedOverAt).toBeUndefined()
  expect(isQueuedAgentJournalSubmission(queuedLate)).toBe(true)
  expect(written(c.on, 'late preparation')).toBeUndefined()
  expect(adapter.heldSends(SESSION)?.has(late)).toBe(false)
  finish(c.on, 'same choice')
  await eventually(() => expect(host.currentWork(SESSION)?.activeTurnId()).toBeNull())
  release.resolve()
  await eventually(() =>
    expect(written(claude.connections.at(-1)!, 'late preparation')).toBeDefined()
  )
  pending.mockRestore()
  const d = claude.connections.at(-1)!
  expect(d).not.toBe(c.on)
  expect(d.launch.options).toMatchObject({ model: 'haiku', permissionMode: 'auto' })
  init(d)
  echo(d, 'late preparation')
  await idle()

  // The end is decoded after pending joins the lane, but its lifecycle fold queues behind it.
  const target = host.currentWork(SESSION)!.activeTurnId()
  let staged = false
  let rolledBack = false
  const queued = vi
    .spyOn(journal, 'resolveDispatch')
    .mockImplementation((input, cards, receipt) => {
      if (!receipt || staged) {
        return resolve(input, cards, receipt)
      }
      staged = true
      let result!: ReturnType<typeof resolve>
      return journal
        .readInOrder(() => {
          result = resolve(input, cards, {
            ...receipt,
            write: (db, row) => {
              expect(host.currentWork(SESSION)?.activeTurnId()).toBe(target)
              try {
                receipt.write(db, row)
              } catch (error) {
                rolledBack = true
                throw error
              }
            }
          })
          finish(d, 'late preparation')
          expect(host.currentWork(SESSION)?.activeTurnId()).toBe(target)
        })
        .then(() => result)
    })
  const lastCapture = { ...choices, model: 'opus' }
  const final = await send('late journal', lastCapture)
  await eventually(() => expect(written(claude.connections.at(-1)!, 'late journal')).toBeDefined())
  queued.mockRestore()
  expect(rolledBack).toBe(true)
  const e = claude.connections.at(-1)!
  expect(e).not.toBe(d)
  expect(e.launch.options).toMatchObject({ model: 'opus', permissionMode: 'auto' })
  init(e, 'auto')
  echo(e, 'late journal')
  await idle()

  // A returned-promise delay after actual COMMIT/offer is already past local admission.
  const offered = Promise.withResolvers<void>()
  const acknowledge = Promise.withResolvers<void>()
  releaseBarriers.push(() => acknowledge.resolve())
  const admitted = vi
    .spyOn(journal, 'resolveDispatch')
    .mockImplementation((input, cards, receipt) => {
      const result = resolve(input, cards, receipt)
      return receipt
        ? result.then(async (cursor) => {
            offered.resolve()
            await acknowledge.promise
            return cursor
          })
        : result
    })
  const currentControls = e.calls.length
  const after = await send('after admission', { model: 'haiku' })
  await eventually(() => expect(written(e, 'after admission')).toBeDefined())
  await offered.promise
  expect(e.calls).toHaveLength(currentControls)
  finish(e, 'late journal')
  await eventually(() => expect(host.currentWork(SESSION)?.activeTurnId()).toBeNull())
  acknowledge.resolve()
  await idle()
  admitted.mockRestore()
  echo(e, 'after admission')
  finish(e, 'after admission')
  await eventually(async () =>
    expect(
      (await snapshot()).submissions.find(({ clientMessageId }) => clientMessageId === after)
        ?.dispatchState
    ).toBe('accepted')
  )
  for (const [id, text, capture] of [
    [late, 'late preparation', lateCapture],
    [final, 'late journal', lastCapture]
  ] as const) {
    expect(
      claude.connections
        .flatMap(({ sent }) => sent)
        .filter(
          (message) => message.message && JSON.stringify(message.message).includes(`"${text}"`)
        )
    ).toHaveLength(1)
    expect(
      (await snapshot()).submissions.find(({ clientMessageId }) => clientMessageId === id)
    ).toMatchObject({ clientMessageId: id, options: capture, dispatchState: 'accepted' })
  }
  expect(
    claude.connections
      .flatMap(({ sent }) => sent)
      .filter((message) => JSON.stringify(message).includes('after admission'))
  ).toHaveLength(1)
  expect(claude.connections).toHaveLength(4)
  expect(
    (await snapshot()).items.flatMap(({ body }) =>
      body.kind === 'message'
        ? body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
  ).toEqual(
    expect.arrayContaining([
      'A result',
      'C result',
      'same choice result',
      'late preparation result',
      'late journal result'
    ])
  )
})
