// A Claude child ended by an Orca fault whose close could not prove it gone, then the user's next
// messages, on the shipping adapter and host. The child may still be running, so the host keeps it
// on record, closing: a message joins that close and retries the kill, and is refused readably while
// the exit stays unproven, never reaching the old child and never written off as `unknown`. The old
// child's exit ends the record as the fault it was, and the next message goes to a new child.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentStatusStructuredSessionSubject } from '../../../shared/agent-status-subject'
import { AgentHookServer } from '../../agent-hooks/server'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
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
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let server: AgentHookServer
let statusSubject: AgentStatusStructuredSessionSubject | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-unproven-fault-send-'))
  resetHostTestOperationIds()
  server = new AgentHookServer()
  statusSubject = undefined
  claude = fakeClaude({
    replayUuid: null,
    routes: { interrupt: () => ({ still_queued: [], cancelled: [] }) }
  })
  const lifecycle: Promise<void>[] = []
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
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
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    onChildWorkEvidence: (sessionId, evidence) =>
      host.publishChildWorkEvidence(sessionId, evidence),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexAgents(adapter),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: recordingStructuredAgentSessionLogger().logger,
    idleSweep: { intervalMs: 1_000_000_000, idleMs: 0 },
    statusSink: {
      publish: (summary, subject) => {
        statusSubject = subject
        server.ingestStructuredStatus(summary, subject)
      },
      forget: (subject) => server.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        server.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
    },
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await adapter.awaitStarted(SESSION)
  await Promise.all(lifecycle)
})

afterEach(async () => {
  // Every child the test left unproven has exited by now.
  for (const connection of claude.connections) {
    connection.exitVerdict = { root: 'exited', tree: 'exited' }
  }
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

function wrote(connection: FakeConnection, text: string): boolean {
  return connection.sent.some((message) => JSON.stringify(message).includes(text))
}

function envelope(
  method: 'agentSession.send' | 'agentSession.cancel',
  fields: Parameters<typeof computeAgentSessionPayloadFingerprint>[0]['fields']
) {
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

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error(`send refused: ${JSON.stringify(sent.refusal)}`)
  }
  return sent.value.clientMessageId
}

function stop() {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
}

async function submission(clientMessageId: string) {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

function laneDrained(): Promise<void> {
  return host['tasks'].serialize(SESSION, async () => {})
}

function hostSession() {
  return host['sessions'].get(SESSION)
}

function liveChildRecords() {
  const records = statusSubject ? server.getStructuredChildWorkViews(statusSubject) : []
  return records.filter((record) => record.membership === 'live')
}

/** The lead's turn ends with a background task still running, as a real Claude leaves it. */
async function turnWithBackgroundTask(connection: FakeConnection): Promise<void> {
  const text = 'Start a background agent.'
  await send(text)
  await eventually(() => expect(wrote(connection, text)).toBe(true))
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'init-1',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  const written = connection.sent.at(-1)!
  frame(connection, { ...written, uuid: written.uuid })
  frame(connection, {
    type: 'assistant',
    uuid: 'leaf-1',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Started.' }] }
  })
  frame(connection, {
    type: 'system',
    subtype: 'task_started',
    uuid: 'task-start',
    task_id: 'background-1',
    task_type: 'local_agent',
    is_backgrounded: true,
    description: 'bg agent'
  })
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1' })
  await host.flushStreamedEvents(SESSION)
}

/** As a loaded machine leaves it: no close can prove the child gone; it still runs. */
function closesUnproven(connection: FakeConnection, pending?: Promise<void>): void {
  connection.exitVerdict = { root: 'live', tree: 'unverifiable' }
  connection.close = async () => {
    connection.closeCount += 1
    connection.closed = true
    if (connection.closeCount > 1) {
      await pending
    }
    return connection.exitVerdict.root === 'exited'
  }
}

/** The journal refuses a background-task row, and the adapter's own fault path ends the child. */
async function faultTheJournal(connection: FakeConnection): Promise<void> {
  const sink = host['runtimeState'].eventSinkFor(SESSION).sink
  vi.spyOn(sink, 'tryAppendResolvedItemAndPublish').mockReturnValueOnce({
    accepted: false,
    reason: 'failed'
  })
  frame(connection, {
    type: 'system',
    subtype: 'task_started',
    uuid: 'task-start-2',
    task_id: 'background-2',
    task_type: 'local_bash',
    is_backgrounded: true,
    description: 'npm run build'
  })
}

/** The old child's own exit, as the real connection reports it: inside the close it began. */
function exits(connection: FakeConnection): void {
  connection.exitVerdict = { root: 'exited', tree: 'exited' }
  connection.handlers.onExit?.(new Error('claude stream-json exited (code 0)'), { expected: true })
}

/** The fault ended the child, its close could not prove it, and the host was told. */
async function faultedUnproven(connection: FakeConnection, pending?: Promise<void>): Promise<void> {
  closesUnproven(connection, pending)
  await faultTheJournal(connection)
  await adapter.drainObservedExits()
  await laneDrained()
}

const REFUSED = "Couldn't stop Claude from before."
const FAULT_ROW = "Orca ran into a problem, so this didn't go through. Try again."

async function faultRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.failure?.kind === 'hostFault' ? [item.body.text] : []
  )
}

async function settled(clientMessageId: string) {
  return eventually(async () => {
    const entry = await submission(clientMessageId)
    expect(entry?.dispatchState).not.toBe('pending')
    return entry
  })
}

it('refuses messages readably after a journal fault whose close was unproven, never sending them or leaving them unknown, and sends the next once the old child exits', async () => {
  const connection = claude.connections[0]!
  await turnWithBackgroundTask(connection)
  await faultedUnproven(connection)
  const sentBefore = connection.sent.length

  // Before: the dispatch threw on a child the adapter no longer held, and the send read `unknown`.
  const held = await send('Hello again after the fault.')
  expect(await settled(held)).toMatchObject({ dispatchState: 'rejected' })
  expect((await submission(held))?.reason).toContain(REFUSED)
  expect(connection.sent.length).toBe(sentBefore)
  // The child may still run: the host keeps it on record, closing, with the fault it reported.
  expect(hostSession()?.child).toMatchObject({
    phase: 'ready',
    close: { cause: 'host-stop', reported: { failure: { kind: 'hostFault' } } }
  })
  const closes = connection.closeCount

  // Stop at rest joins the close and tries the kill again.
  await expect(stop()).resolves.toMatchObject({ ok: true })
  expect(connection.closeCount).toBe(closes + 1)
  expect(hostSession()?.child?.close).toBeDefined()

  // The old child exits: the record ends with the fault, with no sweep tick, and work goes on. The
  // Stop asked for since is the user's.
  exits(connection)
  await eventually(() => expect(hostSession()?.child).toBeNull())
  expect(hostSession()?.lastEndedChild).toMatchObject({
    cause: 'user-stop',
    failure: { kind: 'hostFault' }
  })
  expect(await faultRows()).toEqual([FAULT_ROW])
  expect(liveChildRecords().map((record) => record.providerId)).not.toContain('background-1')

  const next = await send('Carry on.')
  const resumed = await eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, 'Carry on.')).toBe(true)
    return started
  })
  const echoed = resumed.sent.at(-1)!
  frame(resumed, { ...echoed, uuid: echoed.uuid })
  await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
  expect(wrote(connection, 'Carry on.')).toBe(false)

  await expect(host['lifetime'].idleSweep.tick()).resolves.toBeUndefined()
})

it('rejects, never leaves in doubt, a message dispatched after the adapter let go of a child its close has not yet answered for', async () => {
  const connection = claude.connections[0]!
  await turnWithBackgroundTask(connection)
  const closing = Promise.withResolvers<void>()
  closesUnproven(connection, closing.promise)
  await faultTheJournal(connection)
  // The fault's first close gave up; the exit path's own close is still running.
  await eventually(() => expect(connection.closeCount).toBe(2))
  const sentBefore = connection.sent.length

  const raced = await send('Sent while the close runs.')
  expect(await settled(raced)).toMatchObject({
    dispatchState: 'rejected',
    rejection: { kind: 'hostFault' }
  })
  expect(connection.sent.length).toBe(sentBefore)

  closing.resolve()
  await adapter.drainObservedExits()
  await eventually(() => expect(hostSession()?.child?.close?.reported).toBeDefined())
})

it('keeps the child of a journal sink failure whose stop was unproven on record, closing, with the fault', async () => {
  const connection = claude.connections[0]!
  await turnWithBackgroundTask(connection)
  closesUnproven(connection)
  // The host's own recovery: the journal write fails for good, and Orca stops the provider.
  const journal = hostSession()!.journal
  vi.spyOn(journal, 'appendItem').mockRejectedValueOnce(new Error('disk unavailable'))
  frame(connection, {
    type: 'assistant',
    uuid: 'leaf-2',
    parent_tool_use_id: null,
    message: { id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'Lost.' }] }
  })

  await eventually(() =>
    expect(hostSession()?.child?.close).toMatchObject({
      cause: 'host-stop',
      reported: { failure: { kind: 'hostFault' } }
    })
  )
  expect(connection.closeCount).toBeGreaterThan(0)
  host['runtimeState'].eventSinkFor(SESSION)
})

/** A turn still running when the fault comes. */
async function turnRunning(connection: FakeConnection): Promise<void> {
  const text = 'Do a long thing.'
  await send(text)
  await eventually(() => expect(wrote(connection, text)).toBe(true))
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'init-1',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  const written = connection.sent.at(-1)!
  frame(connection, { ...written, uuid: written.uuid })
  frame(connection, {
    type: 'assistant',
    uuid: 'leaf-1',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Working...' }] }
  })
  await host.flushStreamedEvents(SESSION)
}

it.each([
  ['proven at once', false],
  ['proven only by the late exit', true]
])('tells why a turn a journal fault cut short stopped, its close %s', async (_name, unproven) => {
  const connection = claude.connections[0]!
  await turnRunning(connection)
  if (unproven) {
    await faultedUnproven(connection)
    expect(await faultRows()).toEqual([])
    exits(connection)
  } else {
    connection.exitVerdict = { root: 'exited', tree: 'exited' }
    await faultTheJournal(connection)
    await adapter.drainObservedExits()
  }
  await eventually(() => expect(hostSession()?.child).toBeNull())

  // The same end reads the same however long its proof took.
  expect(await turnRows()).toEqual([{ state: 'interrupted', outcome: undefined }])
  expect(await faultRows()).toEqual([FAULT_ROW])
  expect(hostSession()?.lastEndedChild).toMatchObject({
    cause: 'exit',
    failure: { kind: 'hostFault' }
  })
})

async function turnRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'turn' ? [{ state: item.body.state, outcome: item.body.outcome }] : []
  )
}

it.each([
  ['a Stop', 'user-stop'],
  ['a chat close', 'user-close']
] as const)(
  'still tells why a turn a fault cut short stopped when %s comes before the late exit, as the fault alone would',
  async (_name, cause) => {
    const connection = claude.connections[0]!
    await turnRunning(connection)
    await faultedUnproven(connection)
    expect(hostSession()?.child?.close?.reported).toBeDefined()

    // The turn still reads running, so the user acts; that close cannot prove the exit either.
    await (cause === 'user-stop'
      ? expect(stop()).resolves.toMatchObject({ ok: true })
      : expect(host.close(SESSION, 'user-close')).rejects.toThrow())
    await laneDrained()
    exits(connection)
    await eventually(() => expect(hostSession()?.child).toBeNull())

    // The fault ended the turn, so it reads interrupted, never the user's cancellation, with the
    // fault's one row; the end stays the user's.
    expect(await turnRows()).toEqual([{ state: 'interrupted', outcome: undefined }])
    expect(await faultRows()).toEqual([FAULT_ROW])
    expect(hostSession()?.lastEndedChild).toMatchObject({ cause, failure: { kind: 'hostFault' } })
  }
)

it("closes a message accepted while a fault's close was unproven when the chat close that takes it over is proven later", async () => {
  const connection = claude.connections[0]!
  await turnWithBackgroundTask(connection)
  await faultedUnproven(connection)
  const closing = hostSession()!.child!
  const faultAt = closing.close!.requestedAt

  // A message is accepted, then the chat is closed, then the exit is proven, all before the
  // message's delivery step runs.
  const held = Promise.withResolvers<void>()
  const holding = host['tasks'].serialize(SESSION, () => held.promise)
  const sent = send('Sent before the close.')
  // The close's own rejection of what is queued fails, so only where its end stands closes it.
  vi.spyOn(hostSession()!.journal, 'rejectQueuedSubmissions').mockRejectedValueOnce(
    new Error('disk full')
  )
  const closed = host.close(SESSION, 'user-close')
  const ended = host['tasks'].serialize(SESSION, () =>
    host['eventRecovery'].endExitedChildUnderSerialize(SESSION, closing, {
      expected: true,
      reason: 'claude session closed'
    })
  )
  held.resolve()
  await holding
  const message = await sent
  await expect(closed).rejects.toThrow()
  await ended

  // The close took the fault's close over where it was asked, after the message: the end stands
  // there, so the message is closed with the chat and starts no new agent.
  expect(await settled(message)).toMatchObject({
    dispatchState: 'rejected',
    rejection: { kind: 'chatClosed' }
  })
  const end = hostSession()!.lastEndedChild!
  expect(end).toMatchObject({ cause: 'user-close', failure: { kind: 'hostFault' } })
  expect(end.endedAt.sequence).toBeGreaterThan(faultAt.sequence)
  expect(claude.connections).toHaveLength(1)
  expect(wrote(connection, 'Sent before the close.')).toBe(false)
})
